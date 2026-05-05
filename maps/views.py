from django.conf import settings
from django.shortcuts import render
from django.http import JsonResponse
from django.http.multipartparser import MultiPartParser, MultiPartParserError
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from django.core.exceptions import ValidationError
from django.views.decorators.cache import cache_control
from django.utils import timezone
from datetime import timedelta
import json
from .models import (
    AmenityType,
    Amenity,
    Review,
    AmenityPhoto,
    CustomUser,
    Chat,
    ChatParticipant,
    Message,
    ReviewVote,
    Favorite,
)
from django.db.models import (
    Count,
    Sum,
    Q,
    Value,
    IntegerField,
)
from django.db.models.functions import Coalesce
import os
import requests
import io
from PIL import Image, ImageOps
from django.core.files.uploadedfile import InMemoryUploadedFile

import boto3
from boto3.dynamodb.conditions import Key, Attr
import geohash2
import concurrent.futures
from collections import defaultdict
import threading
from botocore.config import Config

AVAILABILITY_WINDOW_HOURS = 3

_thread_local = threading.local()


def get_dynamodb_resource():
    if not hasattr(_thread_local, "dynamodb"):
        kwargs = {"region_name": settings.DYNAMODB_REGION}
        if getattr(settings, "DYNAMODB_ENDPOINT_URL", None):
            kwargs["endpoint_url"] = settings.DYNAMODB_ENDPOINT_URL
        # Global connection pool caching and throttling protection
        config = Config(
            retries={"max_attempts": 3, "mode": "standard"}, max_pool_connections=30
        )
        _thread_local.dynamodb = boto3.resource("dynamodb", config=config, **kwargs)
    return _thread_local.dynamodb


def normalize_longitude(lon):
    """Normalize a longitude to the range [-180, 180]."""
    while lon < -180:
        lon += 360
    while lon > 180:
        lon -= 360
    return lon


def compress_image(uploaded_file, max_dimension=1024, quality=80):
    """
    Resizes and compresses an uploaded image to save storage and bandwidth.
    Converts the image to JPEG format.
    """
    try:
        img = Image.open(uploaded_file)

        # Preserve original EXIF orientation (prevent sideways mobile photos)
        img = ImageOps.exif_transpose(img)

        # Convert to RGB to ensure we can save it as JPEG
        if img.mode in ("RGBA", "P", "LA"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "RGBA":
                background.paste(img, mask=img.split()[3])
            elif img.mode == "LA":
                background.paste(img, mask=img.split()[1])
            else:
                background.paste(img)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # Resize maintaining aspect ratio
        resample_filter = getattr(
            Image.Resampling, "LANCZOS", getattr(Image, "LANCZOS", 1)
        )
        img.thumbnail((max_dimension, max_dimension), resample_filter)

        # Save to buffer
        output = io.BytesIO()
        img.save(output, format="JPEG", quality=quality, optimize=True)
        output.seek(0)

        # Replace extension with .jpg
        base_name, _ = os.path.splitext(uploaded_file.name)
        new_name = f"{base_name}.jpg"

        return InMemoryUploadedFile(
            output,
            "ImageField",
            new_name,
            "image/jpeg",
            output.getbuffer().nbytes,
            None,
        )
    except Exception:
        # If anything fails (e.g. invalid file),
        # return original to let size validation handle it
        return uploaded_file


def map_view(request):
    """Render the main map view."""
    amenity_types = AmenityType.objects.all()
    return render(
        request,
        "maps/map.html",
        {
            "amenity_types": amenity_types,
            "app_release": settings.APP_RELEASE,
        },
    )


@login_required(login_url="/?auth_required=1")
def chats_view(request):
    """Render the chats view for messaging."""
    return render(request, "maps/chats.html")


def get_cluster_grid_size(zoom):
    """
    Determine the grid size for clustering based on the map's zoom level.
    A smaller grid size (larger denominator) means more, smaller clusters.
    A larger grid size (smaller denominator) means fewer, larger clusters.
    These values can be tuned for best visual results.
    """
    if zoom < 5:
        return 0.1  # Very large clusters for continental view
    if zoom < 7:
        return 0.075
    if zoom < 9:
        return 0.05
    if zoom < 11:
        return 0.04
    if zoom < 13:
        return 0.03
    if zoom < 14:
        return 0.02
    if zoom < 15:
        return 0.01
    if zoom < 16:
        return 0.005
    if zoom < 17:
        return 0.002
    return 0.001  # Very small clusters for the highest zoom level


def get_geohashes_in_bbox(north, south, east, west, precision=6):
    """Calculates all geohashes of a given precision that intersect a bounding box."""
    hashes = set()
    lat_step = 0.005  # Approximate step for precision 6
    lon_step = 0.01

    lat = float(south)
    while lat <= float(north) + lat_step:
        lon = float(west)
        while lon <= float(east) + lon_step:
            hashes.add(geohash2.encode(lat, lon, precision))
            lon += lon_step
        lat += lat_step

    return list(hashes)


def cluster_amenities_python(amenities_list, zoom):
    """Performs grid-based clustering natively in Python."""
    grid_size = get_cluster_grid_size(zoom)
    clusters = defaultdict(list)

    for amenity in amenities_list:
        lat = float(amenity["Latitude"])
        lon = float(amenity["Longitude"])

        snapped_lat = round(lat / grid_size) * grid_size
        snapped_lon = round(lon / grid_size) * grid_size

        clusters[(snapped_lat, snapped_lon)].append(amenity)

    result = []
    for (snapped_lat, snapped_lon), items in clusters.items():
        count = len(items)
        centroid_lat = sum(float(i["Latitude"]) for i in items) / count
        centroid_lon = sum(float(i["Longitude"]) for i in items) / count

        result.append(([i["Id"] for i in items], count, centroid_lat, centroid_lon))

    return result


def get_review_prefetch_queryset(user):
    queryset = (
        Review.objects.select_related("user")
        .annotate(
            vote_score=Coalesce(
                Sum("votes__value"), Value(0), output_field=IntegerField()
            ),
            upvote_count=Count("votes", filter=Q(votes__value=1)),
            downvote_count=Count("votes", filter=Q(votes__value=-1)),
        )
        .order_by("-vote_score", "-created_at")
    )
    if user.is_authenticated:
        queryset = queryset.annotate(
            user_vote=Coalesce(
                Sum(
                    "votes__value",
                    filter=Q(votes__user=user),
                ),
                Value(0),
                output_field=IntegerField(),
            )
        )
    return queryset


@cache_control(public=True, max_age=300)
def amenities_api(request):
    """API endpoint to fetch amenities from DynamoDB,
    optionally filtered by type and bounding box."""
    amenity_type_name = request.GET.get("type")
    type_ids = request.GET.getlist("type_id")
    include_inactive = request.GET.get("include_inactive", "false").lower() == "true"
    only_accessible = request.GET.get("only_accessible", "false").lower() == "true"
    zoom = int(request.GET.get("zoom", 0))

    type_names = []
    if type_ids:
        type_names = list(
            AmenityType.objects.filter(id__in=type_ids).values_list("name", flat=True)
        )
    elif amenity_type_name:
        type_names = [amenity_type_name]

    amenities_data = []

    try:
        north = request.GET.get("north")
        south = request.GET.get("south")
        east = request.GET.get("east")
        west = request.GET.get("west")

        try:
            if north and south and east and west:
                north_f = float(north)
                south_f = float(south)
                east_f = float(east)
                west_f = float(west)

                # Prevent massive queries by centering around the middle point
                MAX_LAT_SPAN = 0.02  # ~2.2 km
                MAX_LON_SPAN = 0.02

                if (north_f - south_f) > MAX_LAT_SPAN:
                    center_lat = (north_f + south_f) / 2.0
                    north_f = center_lat + (MAX_LAT_SPAN / 2.0)
                    south_f = center_lat - (MAX_LAT_SPAN / 2.0)

                if (east_f - west_f) > MAX_LON_SPAN:
                    center_lon = (east_f + west_f) / 2.0
                    east_f = center_lon + (MAX_LON_SPAN / 2.0)
                    west_f = center_lon - (MAX_LON_SPAN / 2.0)

                hashes = get_geohashes_in_bbox(
                    north_f, south_f, east_f, west_f, precision=6
                )
            else:
                hashes = None
        except (TypeError, ValueError):
            hashes = None

        if hashes is not None:

            def fetch_hash(h):
                try:
                    # Instantiate per thread to avoid Boto3 thread-locking
                    local_dynamo = get_dynamodb_resource()
                    local_table = local_dynamo.Table(settings.DYNAMODB_TABLE_NAME)

                    # Optimization: Query via DynamoDB index if only 1 type is selected
                    if len(type_names) == 1:
                        sk_prefix = f"TYPE#{type_names[0]}#"
                        if not include_inactive:
                            sk_prefix += "ACTIVE#True"

                        response = local_table.query(
                            IndexName="GeohashIndex",
                            KeyConditionExpression=Key("GSI1PK").eq(f"GEOHASH#{h}")
                            & Key("GSI1SK").begins_with(sk_prefix),
                        )
                    else:
                        response = local_table.query(
                            IndexName="GeohashIndex",
                            KeyConditionExpression=Key("GSI1PK").eq(f"GEOHASH#{h}"),
                        )
                    return response.get("Items", [])
                except Exception as e:
                    print(f"DynamoDB Query Error: {e}")
                    return []

            # Execute DynamoDB queries concurrently
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
                results = executor.map(fetch_hash, hashes)
                for res in results:
                    amenities_data.extend(res)
        else:
            dynamodb = get_dynamodb_resource()
            table = dynamodb.Table(settings.DYNAMODB_TABLE_NAME)
            # Scan fallback for broad non-bounds requests
            response = table.scan(FilterExpression=Attr("PK").begins_with("AMENITY#"))
            amenities_data = response.get("Items", [])
            while "LastEvaluatedKey" in response:
                response = table.scan(
                    FilterExpression=Attr("PK").begins_with("AMENITY#"),
                    ExclusiveStartKey=response["LastEvaluatedKey"],
                )
                amenities_data.extend(response.get("Items", []))
    except Exception as e:
        print("Error retrieving from DynamoDB:", str(e))
        return JsonResponse({"error": str(e)}, status=500)

    # Deduplicate overlapping geohash results
    seen_ids = set()
    unique_amenities = []
    for item in amenities_data:
        if item["Id"] not in seen_ids:
            seen_ids.add(item["Id"])
            unique_amenities.append(item)

    amenity_types_map = {t.name: t for t in AmenityType.objects.all()}

    # In-Memory Single-Table Design Filtering
    filtered_amenities = []
    for item in unique_amenities:
        if not include_inactive and not item.get("Active", True):
            continue
        if type_names and item.get("Type") not in type_names:
            continue
        if only_accessible and item.get("Accessibility", "") == "Not Accessible":
            continue
        filtered_amenities.append(item)

    BIKE_RACK_TYPE_NAME = "Bike Rack"
    CLUSTER_ZOOM_THRESHOLD = 18
    final_amenities_list = []

    bike_rack_amenities = [
        a for a in filtered_amenities if a.get("Type") == BIKE_RACK_TYPE_NAME
    ]
    other_amenities = [
        a for a in filtered_amenities if a.get("Type") != BIKE_RACK_TYPE_NAME
    ]

    is_bike_rack_query = (BIKE_RACK_TYPE_NAME in type_names) if type_names else True

    if is_bike_rack_query and zoom < CLUSTER_ZOOM_THRESHOLD:
        clusters = cluster_amenities_python(bike_rack_amenities, zoom)

        for ids, count, centroid_lat, centroid_lon in clusters:
            if count > 1:
                amenity_type_obj = amenity_types_map.get(BIKE_RACK_TYPE_NAME)
                final_amenities_list.append(
                    {
                        "id": f"cluster_{centroid_lat}_{centroid_lon}",
                        "is_cluster": True,
                        "point_count": count,
                        "latitude": centroid_lat,
                        "longitude": centroid_lon,
                        "type": BIKE_RACK_TYPE_NAME,
                        "type_id": amenity_type_obj.id if amenity_type_obj else None,
                        "icon": (
                            amenity_type_obj.icon if amenity_type_obj else "bicycle"
                        ),
                        "color": (
                            amenity_type_obj.color if amenity_type_obj else "#FF9800"
                        ),
                        "is_favorited": False,
                    }
                )
            else:
                single_id = ids[0]
                single_item = next(
                    (a for a in bike_rack_amenities if a["Id"] == single_id), None
                )
                if single_item:
                    other_amenities.append(single_item)
    elif is_bike_rack_query:
        other_amenities.extend(bike_rack_amenities)

    for a in other_amenities:
        amenity_type_obj = amenity_types_map.get(a.get("Type", ""))

        fallback_icon = "map-marker"
        fallback_color = "#1E88E5"
        if a.get("Type") == BIKE_RACK_TYPE_NAME:
            fallback_icon = "bicycle"
            fallback_color = "#FF9800"

        final_amenities_list.append(
            {
                "id": a.get("Id"),
                "name": a.get("Name"),
                "latitude": float(a.get("Latitude", 0)),
                "longitude": float(a.get("Longitude", 0)),
                "address": a.get("Address", ""),
                "prop_name": a.get("Name", ""),
                "description": a.get("Description", ""),
                "operator": a.get("Operator", ""),
                "hours_of_operation": a.get("HoursOfOperation", {}),
                "changing_stations": a.get("ChangingStations", False),
                "accessibility": a.get("Accessibility", ""),
                "rating": float(a.get("AverageRating", 0)),
                "review_count": int(a.get("ReviewCount", 0)),
                "reviews": [],  # Dynamodb denormalized attribute goes here
                "photo_url": a.get("PrimaryPhotoUrl", None),
                "active": a.get("Active", True),
                "type": a.get("Type", ""),
                "type_id": amenity_type_obj.id if amenity_type_obj else None,
                "icon": amenity_type_obj.icon if amenity_type_obj else fallback_icon,
                "color": amenity_type_obj.color if amenity_type_obj else fallback_color,
                "is_favorited": False,
            }
        )

    return JsonResponse({"amenities": final_amenities_list})


@require_http_methods(["GET"])
def amenity_detail_api(request, amenity_id):
    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table(settings.DYNAMODB_TABLE_NAME)

    try:
        response = table.query(
            KeyConditionExpression=Key("PK").eq(f"AMENITY#{amenity_id}")
        )
        items = response.get("Items", [])

        if not items:
            return JsonResponse({"error": "Amenity not found"}, status=404)

        amenity = next(
            (item for item in items if item["SK"] == f"AMENITY#{amenity_id}"), None
        )
        if not amenity:
            return JsonResponse({"error": "Amenity not found"}, status=404)

        try:
            sqlite_amenity = Amenity.objects.get(external_id=amenity_id)
        except Amenity.DoesNotExist:
            try:
                sqlite_amenity = Amenity.objects.get(id=amenity_id)
            except (Amenity.DoesNotExist, ValueError):
                sqlite_amenity = None

        is_fav = False
        serialized_reviews = []
        avg_rating = 0.0
        review_count = 0

        if sqlite_amenity:
            if request.user.is_authenticated:
                is_fav = Favorite.objects.filter(
                    user=request.user, amenity=sqlite_amenity
                ).exists()

            avg_rating = sqlite_amenity.get_average_rating() or 0.0
            review_count = sqlite_amenity.get_review_count()

            reviews_qs = get_review_prefetch_queryset(request.user).filter(
                amenity=sqlite_amenity
            )[:5]
            for review in reviews_qs:
                photo_urls = [p.photo.url for p in review.photos.all()]
                serialized_reviews.append(
                    serialize_amenity_review(
                        review,
                        photo_url=photo_urls[0] if photo_urls else None,
                        photo_urls=photo_urls,
                        current_user=request.user,
                    )
                )

        amenity_data = {
            "id": amenity.get("Id"),
            "name": amenity.get("Name"),
            "latitude": float(amenity.get("Latitude", 0)),
            "longitude": float(amenity.get("Longitude", 0)),
            "address": amenity.get("Address", ""),
            "prop_name": amenity.get("Name", ""),
            "description": amenity.get("Description", ""),
            "operator": amenity.get("Operator", ""),
            "hours_of_operation": amenity.get("HoursOfOperation", {}),
            "changing_stations": amenity.get("ChangingStations", False),
            "accessibility": amenity.get("Accessibility", ""),
            "rating": float(avg_rating) if avg_rating else None,
            "review_count": int(review_count),
            "reviews": serialized_reviews,
            "photo_url": amenity.get("PrimaryPhotoUrl", None),
            "active": amenity.get("Active", True),
            "type": amenity.get("Type", ""),
            "type_id": None,
            "icon": "map-marker",
            "color": "#1E88E5",
            "is_favorited": is_fav,
        }

        try:
            amenity_type = AmenityType.objects.get(name=amenity.get("Type", ""))
            amenity_data["icon"] = amenity_type.icon
            amenity_data["color"] = amenity_type.color
            amenity_data["type_id"] = amenity_type.id
        except AmenityType.DoesNotExist:
            if amenity.get("Type") == "Bike Rack":
                amenity_data["icon"] = "bicycle"
                amenity_data["color"] = "#FF9800"

        return JsonResponse({"amenity": amenity_data}, status=200)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


def amenity_types_api(request):
    """API endpoint to fetch all amenity types."""
    # Fetch only top-level types (those without a parent)
    top_level_types = AmenityType.objects.filter(parent__isnull=True).prefetch_related(
        "sub_types"
    )

    data = {
        "types": [
            {
                "id": t.id,
                "name": t.name,
                "color": t.color,
                "icon": t.icon,
                "sub_types": [
                    {
                        "id": st.id,
                        "name": st.name,
                        "color": st.color,
                        "icon": st.icon,
                    }
                    for st in t.sub_types.all()
                ],
            }
            for t in top_level_types
        ]
    }
    return JsonResponse(data)


@csrf_exempt
@require_http_methods(["POST"])
def register_api(request):
    """API endpoint for user registration."""
    try:
        data = json.loads(request.body)
        email = data.get("email", "").strip()
        password = data.get("password") or ""
        confirm_password = data.get("confirm_password") or ""

        if not email or not password or not confirm_password:
            return JsonResponse(
                {"error": "Email, password, and confirmation required"},
                status=400,
            )

        if password != confirm_password:
            return JsonResponse(
                {"error": "Password and confirmation do not match"},
                status=400,
            )

        if CustomUser.objects.filter(email=email).exists():
            return JsonResponse({"error": "Email already registered"}, status=400)

        pending_user = CustomUser(username=email, email=email)
        try:
            validate_password(password, pending_user)
        except ValidationError as exc:
            return JsonResponse({"error": " ".join(exc.messages)}, status=400)

        # Create user with email as username and custom fields
        user = CustomUser.objects.create_user(
            username=email, email=email, password=password
        )

        return JsonResponse(
            {
                "id": user.id,
                "email": user.email,
                "message": "User registered successfully",
            },
            status=201,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


def serialize_auth_user(user):
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "bio": user.bio,
        "avatar_url": user.avatar_url,
        "has_usable_password": user.has_usable_password(),
        "is_authenticated": True,
    }


def serialize_amenity_review(
    review, photo_url=None, photo_urls=None, current_user=None
):
    current_user_vote = getattr(review, "user_vote", 0)
    if not (current_user and current_user.is_authenticated):
        current_user_vote = 0

    return {
        "id": review.id,
        "amenity_id": review.amenity.external_id or review.amenity_id,
        "user_name": review.user.username or review.user.email,
        "user_email": review.user.email,
        "user_avatar_url": review.user.avatar_url,
        "rating": review.rating,
        "vote_score": int(getattr(review, "vote_score", 0)),
        "upvote_count": int(getattr(review, "upvote_count", 0)),
        "downvote_count": int(getattr(review, "downvote_count", 0)),
        "user_vote": int(current_user_vote or 0),
        "review_text": review.review_text,
        "photo_url": photo_url,
        "photo_urls": photo_urls or ([photo_url] if photo_url else []),
        "created_at": review.created_at.isoformat(),
    }


@csrf_exempt
@require_http_methods(["POST"])
def login_api(request):
    """
    API endpoint for user login.
    """
    try:
        data = json.loads(request.body)
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()

        if not email or not password:
            return JsonResponse({"error": "Email and password required"}, status=400)

        # Since username field is email, authenticate with email
        user = authenticate(request, username=email, password=password)

        if user is None:
            return JsonResponse({"error": "Invalid email or password"}, status=401)

        # create the session
        login(request, user)

        response_data = serialize_auth_user(user)
        response_data["message"] = "Login successful"
        return JsonResponse(response_data, status=200)

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def logout_api(request):
    """
    Logout endpoint: clear the current session.
    """
    logout(request)
    return JsonResponse(
        {
            "message": "Logout successful",
            "is_authenticated": False,
        },
        status=200,
    )


@require_http_methods(["GET"])
def current_user_api(request):
    """
    Return the user tied to the current session.
    The frontend uses this endpoint after refresh to restore auth state.
    """
    if not request.user.is_authenticated:
        return JsonResponse(
            {
                "id": None,
                "email": "",
                "username": "",
                "bio": "",
                "has_usable_password": False,
                "is_authenticated": False,
            },
            status=200,
        )

    return JsonResponse(serialize_auth_user(request.user), status=200)


def get_profile_target_user(request):
    user_email = request.GET.get("user")
    if user_email:
        try:
            return CustomUser.objects.get(email=user_email)
        except CustomUser.DoesNotExist:
            return request.user
    return request.user


@login_required(login_url="/?auth_required=1")
def profile_view(request):
    """
    Profile page.
    Anonymous users are redirected back to the map page.
    If a ?user=<email> query param is provided, show that user's profile.
    """
    profile_user = get_profile_target_user(request)
    return render(
        request,
        "maps/profile.html",
        {
            "profile_user": profile_user,
            "reviews_count": profile_user.reviews.count(),
            "likes_received_count": ReviewVote.objects.filter(
                review__user=profile_user,
                value=1,
            ).count(),
        },
    )


@login_required(login_url="/?auth_required=1")
def settings_view(request):
    """
    Render the settings page for the current user.
    """
    return render(
        request,
        "maps/settings.html",
        {
            "profile_user": request.user,
            "has_usable_password": request.user.has_usable_password(),
        },
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def change_password_api(request):
    """
    Change the current user's password while preserving the active session.
    """
    has_usable_password = request.user.has_usable_password()
    current_password = (request.POST.get("current_password") or "").strip()
    new_password = (request.POST.get("new_password") or "").strip()
    confirm_password = (request.POST.get("confirm_password") or "").strip()

    if has_usable_password:
        if not current_password or not new_password or not confirm_password:
            return JsonResponse(
                {"error": "All password fields are required"},
                status=400,
            )
    elif not new_password or not confirm_password:
        return JsonResponse(
            {"error": "New password and confirmation are required"},
            status=400,
        )

    if has_usable_password and not request.user.check_password(current_password):
        return JsonResponse({"error": "Current password is incorrect"}, status=400)

    if new_password != confirm_password:
        return JsonResponse(
            {"error": "New password and confirmation do not match"},
            status=400,
        )

    if has_usable_password and current_password == new_password:
        return JsonResponse(
            {"error": "New password must be different from your current password"},
            status=400,
        )

    try:
        validate_password(new_password, request.user)
    except ValidationError as exc:
        return JsonResponse({"error": " ".join(exc.messages)}, status=400)

    request.user.set_password(new_password)
    request.user.save(update_fields=["password"])
    update_session_auth_hash(request, request.user)

    return JsonResponse(
        {
            "message": (
                "Password updated successfully"
                if has_usable_password
                else "Password set successfully"
            ),
            "has_usable_password": True,
            "password_action": "change" if has_usable_password else "set",
        },
        status=200,
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def update_profile_api(request):
    """
    Update the current user's profile fields from the dedicated edit page.
    """
    user = request.user

    username = (request.POST.get("username") or "").strip()
    bio = (request.POST.get("bio") or "").strip()
    avatar_file = request.FILES.get("avatar")

    if not username:
        return JsonResponse({"error": "Username is required"}, status=400)

    if len(username) > 30:
        return JsonResponse(
            {"error": "Username must be 30 characters or fewer"},
            status=400,
        )

    if CustomUser.objects.filter(username=username).exclude(id=user.id).exists():
        return JsonResponse({"error": "Username is already taken"}, status=400)

    if len(bio) > 150:
        return JsonResponse(
            {"error": "Bio must be 150 characters or fewer"},
            status=400,
        )

    if avatar_file:
        content_type = avatar_file.content_type or ""
        if not content_type.startswith("image/"):
            return JsonResponse({"error": "Avatar must be an image"}, status=400)

        # Automatically compress avatars to a maximum of 512x512
        avatar_file = compress_image(avatar_file, max_dimension=512)

        if avatar_file.size > 2 * 1024 * 1024:
            return JsonResponse(
                {"error": "Avatar must be 2MB or smaller"},
                status=400,
            )

        user.avatar = avatar_file

    user.username = username
    user.bio = bio
    user.save()

    response_data = serialize_auth_user(user)
    response_data["message"] = "Profile updated successfully"
    return JsonResponse(response_data, status=200)


def serialize_profile_review(review):
    """
    Serialize one review for the profile page.
    The photo is inferred from the amenity photo uploaded by the same user.
    """
    review_photos = []

    # Reuse prefetched amenity photos when available.
    # The current data model stores review photos on AmenityPhoto,
    # not directly on Review.
    for photo in review.amenity.photos.all():
        if photo.uploaded_by_id == review.user_id:
            review_photos.append(photo)

    review_photo_ids = []
    review_photo_urls = []
    for photo in review_photos:
        # Some legacy or malformed AmenityPhoto rows may not have a file
        # attached. Skip those rows so one bad photo does not break profile.
        try:
            photo_url = photo.photo.url
        except ValueError:
            continue

        review_photo_ids.append(photo.id)
        review_photo_urls.append(photo_url)

    return {
        "id": review.id,
        "amenity_id": review.amenity.external_id or review.amenity_id,
        "amenity_name": review.amenity.name,
        "amenity_prop_name": review.amenity.prop_name,
        "amenity_type": review.amenity.amenity_type.name,
        "rating": review.rating,
        "vote_score": int(getattr(review, "vote_score", 0)),
        "upvote_count": int(getattr(review, "upvote_count", 0)),
        "downvote_count": int(getattr(review, "downvote_count", 0)),
        "user_vote": int(getattr(review, "user_vote", 0) or 0),
        "review_text": review.review_text,
        "photo_id": review_photo_ids[0] if review_photo_ids else None,
        "photo_url": review_photo_urls[0] if review_photo_urls else None,
        "photo_ids": review_photo_ids,
        "photo_urls": review_photo_urls,
        "created_at": review.created_at.isoformat(),
        "updated_at": review.updated_at.isoformat(),
    }


def annotate_reviews_with_vote_score(queryset, user=None):
    queryset = queryset.annotate(
        vote_score=Coalesce(Sum("votes__value"), Value(0), output_field=IntegerField()),
        upvote_count=Count("votes", filter=Q(votes__value=1)),
        downvote_count=Count("votes", filter=Q(votes__value=-1)),
    )
    if user and user.is_authenticated:
        queryset = queryset.annotate(
            user_vote=Coalesce(
                Sum(
                    "votes__value",
                    filter=Q(votes__user=user),
                ),
                Value(0),
                output_field=IntegerField(),
            )
        )
    return queryset


def parse_multipart_request(request):
    parser = MultiPartParser(
        request.META,
        request,
        request.upload_handlers,
        encoding=request.encoding,
    )
    return parser.parse()


def serialize_profile_favorite(favorite):
    amenity = favorite.amenity
    return {
        "id": favorite.id,
        "amenity_id": amenity.external_id or amenity.id,
        "amenity_name": amenity.name,
        "amenity_prop_name": amenity.prop_name,
        "amenity_type": amenity.amenity_type.name,
        "address": amenity.address,
        "latitude": amenity.latitude,
        "longitude": amenity.longitude,
        "notify_on_updates": favorite.notify_on_updates,
        "created_at": favorite.created_at.isoformat(),
    }


@login_required(login_url="/?auth_required=1")
@require_http_methods(["GET"])
def profile_reviews_api(request):
    """
    Return all reviews written by the profile target user.
    """
    profile_user = get_profile_target_user(request)
    reviews = (
        annotate_reviews_with_vote_score(
            Review.objects.filter(user=profile_user),
            request.user,
        )
        .select_related("amenity", "amenity__amenity_type")
        .prefetch_related("amenity__photos")
        .order_by("-updated_at", "-created_at")
    )

    return JsonResponse(
        {
            "reviews": [serialize_profile_review(review) for review in reviews],
        },
        status=200,
    )


@login_required(login_url="/?auth_required=1")
@require_http_methods(["GET"])
def profile_favorites_api(request):
    profile_user = get_profile_target_user(request)
    favorites = (
        Favorite.objects.filter(user=profile_user)
        .select_related("amenity", "amenity__amenity_type")
        .order_by("-created_at")
    )

    return JsonResponse(
        {
            "favorites": [
                serialize_profile_favorite(favorite) for favorite in favorites
            ],
        },
        status=200,
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def favorite_notification_preference_api(request, favorite_id):
    try:
        favorite = Favorite.objects.get(id=favorite_id, user=request.user)
    except Favorite.DoesNotExist:
        return JsonResponse({"error": "Favorite not found"}, status=404)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    notify_on_updates = data.get("notify_on_updates")
    if not isinstance(notify_on_updates, bool):
        return JsonResponse(
            {"error": "notify_on_updates must be a boolean"},
            status=400,
        )

    favorite.notify_on_updates = notify_on_updates
    favorite.save(update_fields=["notify_on_updates"])

    return JsonResponse(
        {
            "favorite_id": favorite.id,
            "notify_on_updates": favorite.notify_on_updates,
            "message": "Favorite notification preference updated",
        },
        status=200,
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST", "DELETE"])
def toggle_favorite_api(request, amenity_id):
    try:
        amenity = Amenity.objects.get(external_id=amenity_id)
    except Amenity.DoesNotExist:
        try:
            amenity = Amenity.objects.get(id=amenity_id)
        except (Amenity.DoesNotExist, ValueError):
            return JsonResponse({"error": "Amenity not found"}, status=404)

    if request.method == "POST":
        favorite, created = Favorite.objects.get_or_create(
            user=request.user,
            amenity=amenity,
        )
        return JsonResponse(
            {
                "amenity_id": amenity.external_id or amenity.id,
                "is_favorited": True,
                "notify_on_updates": favorite.notify_on_updates,
                "message": "Added to favorites" if created else "Already favorited",
            },
            status=200,
        )

    Favorite.objects.filter(user=request.user, amenity=amenity).delete()
    return JsonResponse(
        {
            "amenity_id": amenity.external_id or amenity.id,
            "is_favorited": False,
            "message": "Removed from favorites",
        },
        status=200,
    )


@require_http_methods(["GET"])
def amenity_rating_distribution_api(request, amenity_id):
    """API endpoint to fetch the rating distribution for a specific amenity."""
    try:
        amenity = Amenity.objects.get(external_id=amenity_id)
    except Amenity.DoesNotExist:
        try:
            amenity = Amenity.objects.get(id=amenity_id)
        except (Amenity.DoesNotExist, ValueError):
            return JsonResponse({"error": "Amenity not found"}, status=404)

    rating_distribution = list(
        Review.objects.filter(amenity=amenity)
        .values("rating")
        .annotate(count=Count("rating"))
        .order_by("-rating")
    )

    return JsonResponse(
        {"amenity_id": amenity_id, "rating_distribution": rating_distribution},
        status=200,
    )


@csrf_exempt
@require_http_methods(["POST"])
def create_review_api(request):
    """API endpoint for submitting reviews."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        content_type = request.META.get("CONTENT_TYPE", "")
        if content_type.startswith("multipart/form-data"):
            amenity_id = request.POST.get("amenity_id")
            rating = request.POST.get("rating", 5)
            review_text = (request.POST.get("review_text") or "").strip()
            photo_files = request.FILES.getlist("photos")
            if not photo_files and "photo" in request.FILES:
                photo_files = request.FILES.getlist("photo")
        else:
            data = json.loads(request.body)
            amenity_id = data.get("amenity_id")
            rating = data.get("rating", 5)
            review_text = (data.get("review_text") or "").strip()
            photo_files = []

        if not amenity_id:
            return JsonResponse({"error": "amenity_id required"}, status=400)

        try:
            rating = int(rating)
        except (TypeError, ValueError):
            return JsonResponse({"error": "Rating must be an integer"}, status=400)

        if not (1 <= rating <= 5):
            return JsonResponse({"error": "Rating must be between 1 and 5"}, status=400)

        if len(photo_files) > 5:
            return JsonResponse({"error": "Maximum of 5 photos allowed"}, status=400)

        processed_photos = []
        for photo_file in photo_files:
            file_content_type = photo_file.content_type or ""
            if not file_content_type.startswith("image/"):
                return JsonResponse({"error": "Photo must be an image"}, status=400)

            # Compress review photos to 1024x1024 maximum
            photo_file = compress_image(photo_file, max_dimension=1024)

            if photo_file.size > 5 * 1024 * 1024:
                return JsonResponse(
                    {"error": "Photo must be 5MB or smaller"}, status=400
                )
            processed_photos.append(photo_file)

        photo_files = processed_photos

        try:
            amenity = Amenity.objects.get(external_id=amenity_id)
        except Amenity.DoesNotExist:
            try:
                amenity = Amenity.objects.get(id=amenity_id)
            except (Amenity.DoesNotExist, ValueError):
                return JsonResponse({"error": "Amenity not found"}, status=404)

        user = request.user

        # Check if user already has a review for this amenity
        if Review.objects.filter(amenity=amenity, user=user).exists():
            return JsonResponse(
                {"error": "You have already reviewed this amenity"}, status=400
            )

        review = Review.objects.create(
            amenity=amenity, user=user, rating=rating, review_text=review_text
        )

        review_photos = []
        is_first = not AmenityPhoto.objects.filter(amenity=amenity).exists()
        for i, photo_file in enumerate(photo_files):
            review_photo = AmenityPhoto.objects.create(
                amenity=amenity,
                review=review,
                photo=photo_file,
                uploaded_by=user,
                is_primary=(is_first and i == 0),
                caption=f"Review photo by {user.email}",
            )
            review_photos.append(review_photo)

        # Notify users who favorited this amenity and opted in for updates.
        recipient_ids = list(
            Favorite.objects.filter(
                amenity=amenity,
                notify_on_updates=True,
            )
            .exclude(user=user)
            .values_list("user_id", flat=True)
            .distinct()
        )

        if recipient_ids:
            payload = json.dumps(
                {
                    "type": "amenity_review_added",
                    "amenity_id": amenity.external_id or amenity.id,
                    "amenity_name": amenity.name,
                    "review": {
                        "id": review.id,
                        "rating": review.rating,
                        "created_at": review.created_at.isoformat(),
                    },
                    "actor_email": user.email,
                }
            )

            def send_notification():
                for recipient_id in recipient_ids:
                    try:
                        requests.post(
                            "http://127.0.0.1:8001/api/internal/publish/",
                            json={"user_id": recipient_id, "payload": payload},
                            timeout=1,
                        )
                    except Exception:
                        pass

            transaction.on_commit(send_notification)

        response_data = serialize_amenity_review(
            review,
            photo_url=review_photos[0].photo.url if review_photos else None,
            photo_urls=[rp.photo.url for rp in review_photos] if review_photos else [],
            current_user=request.user,
        )
        response_data["message"] = "Review created successfully"
        return JsonResponse(response_data, status=201)

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def review_vote_api(request, review_id):
    """Create, update, or clear the current user's vote on a review."""
    try:
        try:
            review = Review.objects.select_related("user").get(id=review_id)
        except Review.DoesNotExist:
            return JsonResponse({"error": "Review not found"}, status=404)

        if review.user_id == request.user.id:
            return JsonResponse(
                {"error": "You cannot vote on your own review"},
                status=400,
            )

        data = json.loads(request.body)
        vote = data.get("vote")

        vote_value = None
        if vote in (1, "1", "up", "upvote"):
            vote_value = 1
        elif vote in (-1, "-1", "down", "downvote"):
            vote_value = -1
        elif vote in (0, "0", None, "clear"):
            vote_value = 0

        if vote_value is None:
            return JsonResponse(
                {"error": "vote must be one of: up, down, or clear"},
                status=400,
            )

        existing_vote = ReviewVote.objects.filter(
            review=review,
            user=request.user,
        ).first()

        if vote_value == 0:
            if existing_vote:
                existing_vote.delete()
            user_vote = 0
        elif existing_vote and existing_vote.value == vote_value:
            existing_vote.delete()
            user_vote = 0
        elif existing_vote:
            existing_vote.value = vote_value
            existing_vote.save(update_fields=["value", "updated_at"])
            user_vote = vote_value
        else:
            ReviewVote.objects.create(
                review=review,
                user=request.user,
                value=vote_value,
            )
            user_vote = vote_value

        vote_totals = ReviewVote.objects.filter(review=review).aggregate(
            vote_score=Coalesce(Sum("value"), Value(0), output_field=IntegerField()),
            upvote_count=Count("id", filter=Q(value=1)),
            downvote_count=Count("id", filter=Q(value=-1)),
        )

        return JsonResponse(
            {
                "review_id": review.id,
                "vote_score": int(vote_totals["vote_score"] or 0),
                "upvote_count": int(vote_totals["upvote_count"] or 0),
                "downvote_count": int(vote_totals["downvote_count"] or 0),
                "user_vote": int(user_vote),
            },
            status=200,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["PATCH", "DELETE"])
def review_detail_api(request, review_id):
    """
    Update or delete the current user's own review from the profile page.
    """
    try:
        try:
            review = (
                Review.objects.filter(id=review_id, user=request.user)
                .select_related("amenity", "amenity__amenity_type")
                .prefetch_related("amenity__photos")
                .get()
            )
        except Review.DoesNotExist:
            return JsonResponse({"error": "Review not found"}, status=404)

        if request.method == "DELETE":
            review.delete()
            return JsonResponse(
                {"message": "Review deleted successfully"},
                status=200,
            )

        content_type = request.content_type or ""
        if content_type.startswith("multipart/form-data"):
            try:
                data, files = parse_multipart_request(request)
            except MultiPartParserError:
                return JsonResponse({"error": "Invalid multipart payload"}, status=400)

            rating = data.get("rating", review.rating)
            review_text = data.get("review_text", review.review_text)
            photo_files = files.getlist("photos")
            if not photo_files and "photo" in files:
                photo_files = files.getlist("photo")
        else:
            data = json.loads(request.body)
            rating = data.get("rating", review.rating)
            review_text = data.get("review_text", review.review_text)
            photo_files = []

        try:
            rating = int(rating)
        except (TypeError, ValueError):
            return JsonResponse({"error": "Rating must be an integer"}, status=400)

        if not (1 <= rating <= 5):
            return JsonResponse({"error": "Rating must be between 1 and 5"}, status=400)

        review_text = str(review_text or "").strip()
        if len(review_text) > 600:
            return JsonResponse(
                {"error": "Review text must be 600 characters or fewer"},
                status=400,
            )

        current_photo_count = (
            AmenityPhoto.objects.filter(
                amenity_id=review.amenity_id,
                uploaded_by=request.user,
            )
            .filter(Q(review=review) | Q(review__isnull=True))
            .count()
        )

        if current_photo_count + len(photo_files) > 5:
            return JsonResponse(
                {"error": "You can upload up to 5 photos per review."},
                status=400,
            )

        processed_photos = []
        for photo_file in photo_files:
            file_content_type = photo_file.content_type or ""
            if not file_content_type.startswith("image/"):
                return JsonResponse({"error": "Photo must be an image"}, status=400)

            photo_file = compress_image(photo_file, max_dimension=1024)
            if photo_file.size > 5 * 1024 * 1024:
                return JsonResponse(
                    {"error": "Photo must be 5MB or smaller"}, status=400
                )
            processed_photos.append(photo_file)

        review.rating = rating
        review.review_text = review_text
        review.save(update_fields=["rating", "review_text", "updated_at"])

        is_first_amenity_photo = not AmenityPhoto.objects.filter(
            amenity=review.amenity
        ).exists()
        for index, photo_file in enumerate(processed_photos):
            AmenityPhoto.objects.create(
                amenity=review.amenity,
                review=review,
                photo=photo_file,
                uploaded_by=request.user,
                is_primary=(is_first_amenity_photo and index == 0),
                caption=f"Review photo by {request.user.email}",
            )

        refreshed_review = (
            annotate_reviews_with_vote_score(Review.objects.filter(id=review.id))
            .select_related("amenity", "amenity__amenity_type")
            .prefetch_related("amenity__photos")
            .get()
        )

        response_data = serialize_profile_review(refreshed_review)
        response_data["message"] = "Review updated successfully"
        return JsonResponse(response_data, status=200)

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["DELETE"])
def review_photo_detail_api(request, review_id, photo_id):
    """
    Delete one photo attached to the current user's own review.
    """
    try:
        try:
            review = (
                Review.objects.filter(id=review_id, user=request.user)
                .select_related("amenity", "amenity__amenity_type")
                .prefetch_related("amenity__photos")
                .get()
            )
        except Review.DoesNotExist:
            return JsonResponse({"error": "Review not found"}, status=404)

        photo = (
            AmenityPhoto.objects.filter(
                id=photo_id,
                amenity_id=review.amenity_id,
                uploaded_by=request.user,
            )
            .filter(Q(review=review) | Q(review__isnull=True))
            .first()
        )

        if not photo:
            return JsonResponse({"error": "Photo not found"}, status=404)

        photo.delete()

        refreshed_review = (
            annotate_reviews_with_vote_score(Review.objects.filter(id=review.id))
            .select_related("amenity", "amenity__amenity_type")
            .prefetch_related("amenity__photos")
            .get()
        )

        response_data = serialize_profile_review(refreshed_review)
        response_data["message"] = "Review photo deleted successfully"
        return JsonResponse(response_data, status=200)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@require_http_methods(["GET"])
def get_amenity_reviews_api(request):
    """API endpoint to fetch all reviews for a specific amenity with pagination."""
    try:
        amenity_id = request.GET.get("amenity_id")
        page = int(request.GET.get("page", 1))
        page_size = int(request.GET.get("page_size", 10))

        if not amenity_id:
            return JsonResponse({"error": "amenity_id parameter required"}, status=400)

        try:
            sqlite_amenity = Amenity.objects.get(external_id=amenity_id)
        except Amenity.DoesNotExist:
            try:
                sqlite_amenity = Amenity.objects.get(id=amenity_id)
            except (Amenity.DoesNotExist, ValueError):
                return JsonResponse({"error": "Amenity not found"}, status=404)

        reviews_qs = (
            Review.objects.filter(amenity=sqlite_amenity)
            .select_related("user")
            .order_by("-created_at")
        )

        total_count = reviews_qs.count()
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_reviews = reviews_qs[start_idx:end_idx]

        reviews_data = [
            {
                "id": r.id,
                "user_name": r.user.username or r.user.email if r.user else "Anonymous",
                "rating": r.rating,
                "review_text": r.review_text,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
            for r in paginated_reviews
        ]

        return JsonResponse(
            {
                "amenity_id": amenity_id,
                "amenity_name": sqlite_amenity.name,
                "total_reviews": total_count,
                "average_rating": float(sqlite_amenity.get_average_rating() or 0),
                "page": page,
                "page_size": page_size,
                "total_pages": (total_count + page_size - 1) // page_size,
                "reviews": reviews_data,
            },
            status=200,
        )

    except (ValueError, TypeError):
        return JsonResponse(
            {"error": "Invalid page or page_size parameter"}, status=400
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


# ===== Chat Functionality APIs =====


@csrf_exempt
@require_http_methods(["GET"])
def get_user_chats_api(request):
    """Get all chats for the current user."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        # Get all chats where the user is a participant
        user_chats = (
            Chat.objects.filter(participants__user=request.user)
            .select_related("created_by", "amenity")
            .prefetch_related("participants__user", "messages")
            .distinct()
            .order_by("-last_message_at")
        )

        chats_data = []
        for chat in user_chats:
            # Get the last message (using prefetched list to avoid N+1 queries)
            messages_list = list(chat.messages.all())
            last_message = messages_list[-1] if messages_list else None

            my_participant = next(
                (p for p in chat.participants.all() if p.user_id == request.user.id),
                None,
            )

            is_unread = False
            if last_message and last_message.sender_id != request.user.id:
                if my_participant and (
                    not my_participant.last_read_at
                    or last_message.created_at > my_participant.last_read_at
                ):
                    is_unread = True

            avatar_url = None
            other_user_email = None
            if chat.chat_type == "direct":
                # Find the other participant to get their avatar and email
                other_p = next(
                    (
                        p
                        for p in chat.participants.all()
                        if p.user_id != request.user.id
                    ),
                    None,
                )
                if other_p:
                    if getattr(other_p.user, "avatar_url", None):
                        avatar_url = other_p.user.avatar_url
                    other_user_email = other_p.user.email
            else:
                if chat.created_by and getattr(chat.created_by, "avatar_url", None):
                    avatar_url = chat.created_by.avatar_url

            chats_data.append(
                {
                    "id": chat.id,
                    "chat_type": chat.chat_type,
                    "name": chat.get_display_name(request.user),
                    "avatar_url": avatar_url,
                    "other_user_email": other_user_email,
                    "amenity_id": (
                        chat.amenity.external_id
                        if (chat.amenity and chat.amenity.external_id)
                        else (chat.amenity.id if chat.amenity else None)
                    ),
                    "amenity_name": chat.amenity.name if chat.amenity else None,
                    "created_by_email": (
                        chat.created_by.email if chat.created_by else None
                    ),
                    "participant_count": chat.participants.count(),
                    "last_message": (
                        last_message.content[:100]
                        if last_message and last_message.content
                        else None
                    ),
                    "last_message_sender": (
                        last_message.sender.email if last_message else None
                    ),
                    "last_message_at": (
                        chat.last_message_at.isoformat()
                        if chat.last_message_at
                        else (chat.created_at.isoformat() if chat.created_at else None)
                    ),
                    "created_at": (
                        chat.created_at.isoformat() if chat.created_at else None
                    ),
                    "is_unread": is_unread,
                }
            )

        return JsonResponse(
            {
                "chats": chats_data,
                "total_count": len(chats_data),
            },
            status=200,
        )

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["GET"])
def get_chat_messages_api(request):
    """Get messages for a specific chat."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        chat_id = request.GET.get("chat_id")
        page = int(request.GET.get("page", 1))
        page_size = int(request.GET.get("page_size", 20))

        if not chat_id:
            return JsonResponse({"error": "chat_id parameter required"}, status=400)

        try:
            chat = Chat.objects.get(id=chat_id)
        except Chat.DoesNotExist:
            return JsonResponse({"error": "Chat not found"}, status=404)

        # Check if user is a participant in this chat
        participant = chat.participants.filter(user=request.user).first()
        if not participant:
            return JsonResponse(
                {"error": "You are not a participant in this chat"}, status=403
            )

        participant.last_read_at = timezone.now()
        participant.save(update_fields=["last_read_at"])

        # Get messages with pagination
        messages = chat.messages.select_related("sender").order_by("-created_at", "-id")
        total_count = messages.count()
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_messages = messages[start_idx:end_idx]

        messages_data = [
            {
                "id": m.id,
                "sender_id": m.sender.id if m.sender else None,
                "sender_email": m.sender.email if m.sender else None,
                "content": m.content,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in paginated_messages
        ]

        # Reverse to get chronological order
        messages_data.reverse()

        return JsonResponse(
            {
                "chat_id": chat.id,
                "chat_type": chat.chat_type,
                "chat_name": chat.get_display_name(request.user),
                "amenity_id": (
                    chat.amenity.external_id
                    if (chat.amenity and chat.amenity.external_id)
                    else (chat.amenity.id if chat.amenity else None)
                ),
                "page": page,
                "page_size": page_size,
                "total_messages": total_count,
                "total_pages": (total_count + page_size - 1) // page_size,
                "messages": messages_data,
            },
            status=200,
        )

    except (ValueError, TypeError):
        return JsonResponse(
            {"error": "Invalid page or page_size parameter"}, status=400
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def send_message_api(request):
    """Send a message in a chat."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        data = json.loads(request.body)
        chat_id = data.get("chat_id")
        content = (data.get("content") or "").strip()

        if not chat_id:
            return JsonResponse({"error": "chat_id required"}, status=400)

        if not content:
            return JsonResponse({"error": "content required"}, status=400)

        try:
            chat = Chat.objects.get(id=chat_id)
        except Chat.DoesNotExist:
            return JsonResponse({"error": "Chat not found"}, status=404)

        # Check if user is a participant
        if not chat.participants.filter(user=request.user).exists():
            return JsonResponse(
                {"error": "You are not a participant in this chat"}, status=403
            )

        # Create the message
        message = Message.objects.create(
            chat=chat, sender=request.user, content=content
        )

        # Update chat's last_message_at
        chat.last_message_at = message.created_at
        chat.save(update_fields=["last_message_at"])

        # NOTIFY all other participants
        payload = json.dumps(
            {
                "type": "new_message",
                "chat_id": chat.id,
                "message": {
                    "id": message.id,
                    "sender_email": message.sender.email,
                    "content": message.content,
                    "created_at": message.created_at.isoformat(),
                },
            }
        )

        def send_notification():
            for p in chat.participants.exclude(user=request.user):
                try:
                    requests.post(
                        "http://127.0.0.1:8001/api/internal/publish/",
                        json={"user_id": p.user_id, "payload": payload},
                        timeout=1,
                    )
                except Exception:
                    pass

        transaction.on_commit(send_notification)

        return JsonResponse(
            {
                "id": message.id,
                "chat_id": chat.id,
                "sender_id": message.sender.id,
                "sender_email": message.sender.email,
                "content": message.content,
                "created_at": message.created_at.isoformat(),
            },
            status=201,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def create_direct_chat_api(request):
    """Create or get a direct message chat with another user."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        data = json.loads(request.body)
        recipient_email = (data.get("recipient_email") or "").strip()

        if not recipient_email:
            return JsonResponse({"error": "recipient_email required"}, status=400)

        try:
            recipient = CustomUser.objects.get(email=recipient_email)
        except CustomUser.DoesNotExist:
            return JsonResponse({"error": "Recipient user not found"}, status=404)

        if recipient.id == request.user.id:
            return JsonResponse(
                {"error": "Cannot create chat with yourself"}, status=400
            )

        # Check if direct chat already exists between these two users
        existing_chat = (
            Chat.objects.filter(chat_type="direct", participants__user=request.user)
            .filter(participants__user=recipient)
            .first()
        )

        if existing_chat:
            return JsonResponse(
                {
                    "id": existing_chat.id,
                    "chat_type": existing_chat.chat_type,
                    "name": existing_chat.get_display_name(request.user),
                    "created_at": existing_chat.created_at.isoformat(),
                    "message": "Chat already exists",
                },
                status=200,
            )

        # Create new direct chat
        chat = Chat.objects.create(
            chat_type="direct",
            created_by=request.user,
        )

        # Add both users as participants
        ChatParticipant.objects.create(chat=chat, user=request.user)
        ChatParticipant.objects.create(chat=chat, user=recipient)

        # NOTIFY the recipient
        payload = json.dumps({"type": "new_message", "chat_id": chat.id})

        def send_notification():
            try:
                requests.post(
                    "http://127.0.0.1:8001/api/internal/publish/",
                    json={"user_id": recipient.id, "payload": payload},
                    timeout=1,
                )
            except Exception:
                pass

        transaction.on_commit(send_notification)

        return JsonResponse(
            {
                "id": chat.id,
                "chat_type": chat.chat_type,
                "name": chat.get_display_name(request.user),
                "created_at": chat.created_at.isoformat(),
                "message": "Chat created successfully",
            },
            status=201,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def create_group_chat_api(request):
    """Create a group chat, optionally with recent reviewers of an amenity."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        data = json.loads(request.body)
        chat_name = (data.get("chat_name") or "").strip()
        amenity_id = data.get("amenity_id")
        participant_emails = data.get("participant_emails", [])

        if not chat_name:
            return JsonResponse({"error": "chat_name required"}, status=400)

        if not participant_emails:
            return JsonResponse({"error": "participant_emails required"}, status=400)

        # Get participants
        participants = CustomUser.objects.filter(email__in=participant_emails)
        if participants.count() != len(participant_emails):
            return JsonResponse(
                {"error": "One or more participants not found"}, status=404
            )

        # Ensure creator is in the participant list
        if request.user not in participants:
            participants = list(participants) + [request.user]
        else:
            participants = list(participants)

        # Get amenity if provided (for forum chats)
        amenity = None
        if amenity_id:
            try:
                amenity = Amenity.objects.get(external_id=amenity_id)
            except Amenity.DoesNotExist:
                try:
                    amenity = Amenity.objects.get(id=amenity_id)
                except (Amenity.DoesNotExist, ValueError):
                    return JsonResponse({"error": "Amenity not found"}, status=404)

        # Create the group chat
        chat_type = "amenity_forum" if amenity else "group"
        chat = Chat.objects.create(
            chat_type=chat_type,
            amenity=amenity,
            created_by=request.user,
            name=chat_name,
        )

        # Add participants
        for participant in participants:
            ChatParticipant.objects.create(chat=chat, user=participant)

        # NOTIFY other participants
        payload = json.dumps({"type": "new_message", "chat_id": chat.id})

        def send_notification():
            for participant in participants:
                if participant.id != request.user.id:
                    try:
                        requests.post(
                            "http://127.0.0.1:8001/api/internal/publish/",
                            json={"user_id": participant.id, "payload": payload},
                            timeout=1,
                        )
                    except Exception:
                        pass

        transaction.on_commit(send_notification)

        return JsonResponse(
            {
                "id": chat.id,
                "chat_type": chat.chat_type,
                "name": chat.name,
                "participant_count": len(participants),
                "created_at": chat.created_at.isoformat(),
                "message": "Group chat created successfully",
            },
            status=201,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["GET"])
def get_chat_participants_api(request):
    """Get participants for a specific chat."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        chat_id = request.GET.get("chat_id")
        if not chat_id:
            return JsonResponse({"error": "chat_id parameter required"}, status=400)

        try:
            chat = Chat.objects.get(id=chat_id)
        except Chat.DoesNotExist:
            return JsonResponse({"error": "Chat not found"}, status=404)

        if not chat.participants.filter(user=request.user).exists():
            return JsonResponse(
                {"error": "You are not a participant in this chat"}, status=403
            )

        participants_data = [
            {
                "user_id": p.user.id if p.user else None,
                "email": p.user.email if p.user else None,
                "username": p.user.username or p.user.email,
                "avatar_url": getattr(p.user, "avatar_url", None) or "",
                "joined_at": p.joined_at.isoformat() if p.joined_at else None,
            }
            for p in chat.participants.select_related("user")
        ]

        return JsonResponse(
            {
                "chat_id": chat.id,
                "participants": participants_data,
            }
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def add_chat_participants_api(request):
    """Add one or more participants to an existing group or forum chat."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    chat_id = data.get("chat_id")
    participant_emails = data.get("participant_emails", [])

    if not chat_id:
        return JsonResponse({"error": "chat_id required"}, status=400)

    if not participant_emails:
        return JsonResponse({"error": "participant_emails required"}, status=400)

    try:
        chat = Chat.objects.get(id=chat_id)
    except Chat.DoesNotExist:
        return JsonResponse({"error": "Chat not found"}, status=404)

    if not chat.participants.filter(user=request.user).exists():
        return JsonResponse(
            {"error": "You are not a participant in this chat"}, status=403
        )

    if chat.chat_type == "direct":
        return JsonResponse(
            {"error": "Cannot add participants to a direct message chat"}, status=400
        )

    existing_user_ids = set(chat.participants.values_list("user_id", flat=True))

    users_to_add = []
    for email in participant_emails:
        email = email.strip()
        if not email:
            continue
        try:
            user = CustomUser.objects.get(email=email)
        except CustomUser.DoesNotExist:
            return JsonResponse(
                {"error": f"No user found with email '{email}'"}, status=404
            )
        if user.id in existing_user_ids:
            return JsonResponse(
                {"error": f"{email} is already a participant in this chat"}, status=400
            )
        users_to_add.append(user)

    if not users_to_add:
        return JsonResponse({"error": "No valid new participants provided"}, status=400)

    for user in users_to_add:
        ChatParticipant.objects.create(chat=chat, user=user)

    participants_data = [
        {
            "user_id": p.user.id if p.user else None,
            "email": p.user.email if p.user else None,
            "username": p.user.username or p.user.email,
            "avatar_url": getattr(p.user, "avatar_url", None) or "",
            "joined_at": p.joined_at.isoformat() if p.joined_at else None,
        }
        for p in chat.participants.select_related("user")
    ]

    return JsonResponse(
        {
            "chat_id": chat.id,
            "participants": participants_data,
            "participant_count": len(participants_data),
            "message": f"Added {len(users_to_add)} participant(s) successfully",
        },
        status=200,
    )


@csrf_exempt
@require_http_methods(["POST"])
def leave_chat_api(request):
    """Leave a chat."""
    try:
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Login required"}, status=401)

        data = json.loads(request.body)
        chat_id = data.get("chat_id")
        if not chat_id:
            return JsonResponse({"error": "chat_id required"}, status=400)

        ChatParticipant.objects.filter(chat_id=chat_id, user=request.user).delete()

        return JsonResponse({"message": "Successfully left the chat"})
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@require_http_methods(["GET"])
def amenity_search_api(request):
    """Search amenities by name for group chat creation."""
    q = request.GET.get("q", "").strip()
    limit = min(int(request.GET.get("limit", 10)), 20)

    if len(q) < 2:
        return JsonResponse({"amenities": []})

    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table(settings.DYNAMODB_TABLE_NAME)

    try:
        response = table.scan(
            FilterExpression=Attr("PK").begins_with("AMENITY#")
            & Attr("Name").contains(q)
            & Attr("Active").eq(True)
        )

        items = response.get("Items", [])
        items = sorted(items, key=lambda x: x.get("Name", ""))[:limit]

        return JsonResponse(
            {
                "amenities": [
                    {
                        "id": a.get("Id"),
                        "name": a.get("Name"),
                        "address": a.get("Address", ""),
                        "type": a.get("Type", ""),
                    }
                    for a in items
                ]
            }
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@require_http_methods(["GET"])
@login_required(login_url="/?auth_required=1")
def user_search_api(request):
    """Search users by email or username for chat autocomplete."""
    q = request.GET.get("q", "").strip()
    limit = min(int(request.GET.get("limit", 10)), 20)

    if len(q) < 2:
        return JsonResponse({"users": []})

    # Search matching users by email or username, excluding the current user
    users = (
        CustomUser.objects.filter(
            Q(email__icontains=q) | Q(username__icontains=q), is_active=True
        )
        .exclude(id=request.user.id)
        .order_by("email")[:limit]
    )

    return JsonResponse({"users": [serialize_auth_user(u) for u in users]})


@require_http_methods(["GET"])
def get_amenity_reviewers_api(request):
    """Get list of recent reviewers for an amenity (for starting group chats)."""
    try:
        amenity_id = request.GET.get("amenity_id")
        limit = int(request.GET.get("limit", 10))

        if not amenity_id:
            return JsonResponse({"error": "amenity_id parameter required"}, status=400)

        try:
            sqlite_amenity = Amenity.objects.get(external_id=amenity_id)
        except Amenity.DoesNotExist:
            try:
                sqlite_amenity = Amenity.objects.get(id=amenity_id)
            except (Amenity.DoesNotExist, ValueError):
                return JsonResponse({"error": "Amenity not found"}, status=404)

        reviews_qs = (
            Review.objects.filter(amenity=sqlite_amenity, user__isnull=False)
            .select_related("user")
            .order_by("-created_at")[:limit]
        )

        reviewers_data = [
            {
                "user_id": r.user.id,
                "email": r.user.email,
                "rating": r.rating,
                "review_text": (r.review_text[:100] if r.review_text else None),
                "created_at": r.created_at.isoformat(),
            }
            for r in reviews_qs
        ]

        return JsonResponse(
            {
                "amenity_id": amenity_id,
                "amenity_name": sqlite_amenity.name,
                "reviewers": reviewers_data,
                "total_reviewers": len(reviewers_data),
            },
            status=200,
        )
    except (ValueError, TypeError):
        return JsonResponse({"error": "Invalid limit parameter"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


def availability_status_api(request, amenity_id):
    """GET: return available/unavailable counts for the last 3 hours."""
    cutoff = timezone.now() - timedelta(hours=AVAILABILITY_WINDOW_HOURS)
    cutoff_iso = cutoff.isoformat()

    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table(settings.DYNAMODB_TABLE_NAME)

    amenity_response = table.get_item(
        Key={"PK": f"AMENITY#{amenity_id}", "SK": f"AMENITY#{amenity_id}"}
    )
    if not amenity_response.get("Item"):
        return JsonResponse({"error": "Not found"}, status=404)

    response = table.query(
        KeyConditionExpression=Key("PK").eq(f"AMENITY#{amenity_id}")
        & Key("SK").begins_with("AVAILABILITY#")
    )
    items = response.get("Items", [])

    recent_reports = [
        item for item in items if item.get("ReportedAt", "") >= cutoff_iso
    ]

    available_count = sum(1 for r in recent_reports if r.get("IsAvailable") is True)
    unavailable_count = sum(1 for r in recent_reports if r.get("IsAvailable") is False)

    recent_reports.sort(key=lambda x: x.get("ReportedAt", ""), reverse=True)
    latest = recent_reports[0] if recent_reports else None

    if not request.session.session_key:
        request.session.create()
    session_key = request.session.session_key or ""

    user_report = next(
        (r for r in recent_reports if r["SK"] == f"AVAILABILITY#{session_key}"), None
    )
    user_vote = None
    if user_report:
        user_vote = "available" if user_report.get("IsAvailable") else "unavailable"

    return JsonResponse(
        {
            "available": available_count,
            "unavailable": unavailable_count,
            "total": available_count + unavailable_count,
            "last_reported": latest.get("ReportedAt") if latest else None,
            "user_vote": user_vote,
            "window_hours": AVAILABILITY_WINDOW_HOURS,
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def report_availability_api(request, amenity_id):
    """POST: submit or change an availability report."""
    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table(settings.DYNAMODB_TABLE_NAME)

    amenity_response = table.get_item(
        Key={"PK": f"AMENITY#{amenity_id}", "SK": f"AMENITY#{amenity_id}"}
    )
    if not amenity_response.get("Item"):
        return JsonResponse({"error": "Not found"}, status=404)

    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    is_available = data.get("is_available")
    if is_available is None:
        return JsonResponse({"error": "is_available is required"}, status=400)

    if not request.session.session_key:
        request.session.create()
    session_key = request.session.session_key or ""

    now_iso = timezone.now().isoformat()
    # Utilize DynamoDB's Native TTL feature to auto-expire records after 48 hours
    expires_at = int((timezone.now() + timedelta(hours=48)).timestamp())

    table.put_item(
        Item={
            "PK": f"AMENITY#{amenity_id}",
            "SK": f"AVAILABILITY#{session_key}",
            "IsAvailable": bool(is_available),
            "ReportedAt": now_iso,
            "ExpiresAt": expires_at,
        }
    )

    cutoff = timezone.now() - timedelta(hours=AVAILABILITY_WINDOW_HOURS)
    cutoff_iso = cutoff.isoformat()

    response = table.query(
        KeyConditionExpression=Key("PK").eq(f"AMENITY#{amenity_id}")
        & Key("SK").begins_with("AVAILABILITY#")
    )
    items = response.get("Items", [])
    recent_reports = [
        item for item in items if item.get("ReportedAt", "") >= cutoff_iso
    ]

    available_count = sum(1 for r in recent_reports if r.get("IsAvailable") is True)
    unavailable_count = sum(1 for r in recent_reports if r.get("IsAvailable") is False)

    return JsonResponse(
        {
            "ok": True,
            "available": available_count,
            "unavailable": unavailable_count,
            "total": available_count + unavailable_count,
            "user_vote": "available" if is_available else "unavailable",
        }
    )
