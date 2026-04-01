from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.contrib.gis.geos import Polygon, GEOSGeometry
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
    Avg,
    Count,
    Subquery,
    OuterRef,
    Sum,
    Q,
    Value,
    IntegerField,
    Prefetch,
)
from django.db.models.functions import Coalesce
from decimal import Decimal, InvalidOperation
import json


def normalize_longitude(lon):
    """Normalize a longitude to the range [-180, 180]."""
    while lon < -180:
        lon += 360
    while lon > 180:
        lon -= 360
    return lon


def map_view(request):
    """Render the main map view."""
    amenity_types = AmenityType.objects.all()
    return render(request, "maps/map.html", {"amenity_types": amenity_types})


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


def cluster_amenities(amenities, zoom):
    """
    Performs grid-based clustering on a queryset of amenities.
    """
    grid_size = get_cluster_grid_size(zoom)

    # This query is more efficient for grid-based clustering than the ORM equivalent.
    # It groups points into a grid, counts them, and finds the centroid of each group.
    cluster_query = """
        SELECT
            array_agg(id) as ids,
            COUNT(id) as point_count,
            ST_AsText(ST_Centroid(ST_Collect(location))) as centroid,
            MIN(id) as id
        FROM (
            SELECT id, ST_SnapToGrid(location, %s) as snapped_location, location
            FROM maps_amenity
            WHERE id = ANY(%s)
        ) as sub
        GROUP BY snapped_location
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            cluster_query, [grid_size, list(amenities.values_list("id", flat=True))]
        )
        return cursor.fetchall()


def get_review_prefetch_queryset(user):
    queryset = (
        Review.objects.select_related("user")
        .annotate(
            vote_score=Coalesce(
                Sum("votes__value"), Value(0), output_field=IntegerField()
            )
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


def serialize_map_amenity(amenity, user, favorite_amenity_ids=None):
    if favorite_amenity_ids is None:
        favorite_amenity_ids = set()

    photo_by_user = {}
    for photo in amenity.photos.all():
        if photo.uploaded_by_id not in photo_by_user:
            photo_by_user[photo.uploaded_by_id] = photo.photo.url

    return {
        "id": amenity.id,
        "name": amenity.name,
        "latitude": amenity.location.y,
        "longitude": amenity.location.x,
        "address": amenity.address,
        "prop_name": amenity.prop_name,
        "description": amenity.description,
        "operator": amenity.operator,
        "hours_of_operation": amenity.hours_of_operation,
        "changing_stations": amenity.changing_stations,
        "accessibility": amenity.accessibility,
        "rating": getattr(amenity, "avg_rating", None),
        "review_count": getattr(amenity, "review_count", 0),
        "reviews": [
            serialize_amenity_review(
                review,
                photo_url=photo_by_user.get(review.user_id),
                current_user=user,
            )
            for review in amenity.reviews.all()[:5]
        ],
        "photo_url": getattr(amenity, "primary_photo_url", None),
        "active": amenity.active,
        "type": amenity.amenity_type.name,
        "type_id": amenity.amenity_type.id,
        "icon": amenity.amenity_type.icon,
        "color": amenity.amenity_type.color,
        "is_favorited": amenity.id in favorite_amenity_ids,
    }


def amenities_api(request):
    """API endpoint to fetch amenities, optionally filtered by type and bounding box."""
    amenity_type_ids = request.GET.getlist("type_id")
    amenity_type_name = request.GET.get("type")
    include_inactive = request.GET.get("include_inactive", "false").lower() == "true"
    only_accessible = request.GET.get("only_accessible", "false").lower() == "true"
    zoom = int(request.GET.get("zoom", 0))

    # Get bounding box parameters (from map pan/zoom)
    try:
        north = request.GET.get("north")
        south = request.GET.get("south")
        east = request.GET.get("east")
        west = request.GET.get("west")

        # If bounding box is provided, use it for filtering
        if north and south and east and west:
            north = Decimal(north)
            south = Decimal(south)
            east = Decimal(east)
            west = Decimal(west)

            # Create a Polygon object for the bounding box
            bbox = (west, south, east, north)
            amenities = Amenity.objects.filter(
                location__bboverlaps=Polygon.from_bbox(bbox)
            )

        else:
            amenities = Amenity.objects.all()
    except (ValueError, TypeError, InvalidOperation):
        amenities = Amenity.objects.all()

    # Filter by amenity type if specified
    if amenity_type_ids:
        amenities = amenities.filter(amenity_type_id__in=amenity_type_ids)
    elif amenity_type_name:
        # Allow filtering by type name as well
        amenities = amenities.filter(amenity_type__name__iexact=amenity_type_name)

    # Filter by active status unless explicitly showing inactive
    if not include_inactive:
        amenities = amenities.filter(active=True)

    # Filter by accessibility if requested
    if only_accessible:
        amenities = amenities.exclude(accessibility="Not Accessible")

    # --- Performance Optimization: Annotate data at the database level ---
    # This must be done BEFORE any .union() operations.

    # 1. Annotate average rating and review count
    amenities = amenities.annotate(
        avg_rating=Avg("reviews__rating"),
        review_count=Count("reviews__id", distinct=True),
    )

    # 2. Use a Subquery to efficiently get the primary photo URL
    primary_photo_subquery = AmenityPhoto.objects.filter(
        amenity=OuterRef("pk"), is_primary=True
    ).values("photo")[:1]

    amenities = amenities.annotate(primary_photo_url=Subquery(primary_photo_subquery))

    # 3. Apply select_related and prefetch_related BEFORE the union.
    review_prefetch_queryset = get_review_prefetch_queryset(request.user)

    amenities = amenities.select_related("amenity_type").prefetch_related(
        Prefetch("reviews", queryset=review_prefetch_queryset),
        "photos",
    )

    # --- Backend Clustering Logic ---
    BIKE_RACK_TYPE_NAME = "Bike Rack"
    CLUSTER_ZOOM_THRESHOLD = (
        18  # Cluster below this zoom level. Increase to cluster at higher zoom levels.
    )
    final_amenities_list = []

    try:
        bike_rack_type = AmenityType.objects.get(name=BIKE_RACK_TYPE_NAME)
        is_bike_rack_query = str(bike_rack_type.id) in amenity_type_ids
    except AmenityType.DoesNotExist:
        is_bike_rack_query = False
        bike_rack_type = None

    # Separate bike racks for clustering, if they were requested
    bike_rack_amenities = None
    if is_bike_rack_query:
        bike_rack_amenities = amenities.filter(amenity_type=bike_rack_type)
        # Exclude bike racks from the main queryset to avoid duplication
        amenities = amenities.exclude(amenity_type=bike_rack_type)

    # Perform clustering only on bike racks and only if zoomed out
    if is_bike_rack_query and zoom < CLUSTER_ZOOM_THRESHOLD:
        clusters = cluster_amenities(bike_rack_amenities, zoom)

        single_point_ids = []
        for ids, count, centroid_wkt, _ in clusters:
            centroid = GEOSGeometry(centroid_wkt)
            if count > 1:
                # This is a cluster
                final_amenities_list.append(
                    {
                        "id": f"cluster_{centroid.y}_{centroid.x}",
                        "is_cluster": True,
                        "point_count": count,
                        "latitude": centroid.y,
                        "longitude": centroid.x,
                        "type": BIKE_RACK_TYPE_NAME,
                        "type_id": bike_rack_type.id,
                        "icon": "bicycle",
                        "color": "#FF9800",
                        "is_favorited": False,
                    }
                )
            else:
                # This is a single point. Collect its ID to be processed normally.
                single_point_ids.extend(ids)

        # Add back the single bike rack points to the main `amenities` queryset
        # so they get full data serialization.
        single_bike_racks = bike_rack_amenities.filter(
            id__in=single_point_ids
        )  # This queryset already has annotations
        amenities = amenities.union(single_bike_racks)

    elif is_bike_rack_query:
        # If bike racks were requested but we are zoomed in past the threshold,
        # add them to the main queryset to be rendered as individual points.
        amenities = amenities.union(bike_rack_amenities)

    # If we have any clusters, we need to serialize the remaining individual amenities
    # and add them to the list.
    if final_amenities_list and not amenities.exists():
        return JsonResponse({"amenities": final_amenities_list})

    # If there are no amenities left to process (e.g., only clusters were found),
    # return the clusters.
    if not amenities.exists():
        return JsonResponse({"amenities": final_amenities_list})

    favorite_amenity_ids = set()
    if request.user.is_authenticated:
        amenity_ids = list(amenities.values_list("id", flat=True))
        favorite_amenity_ids = set(
            Favorite.objects.filter(
                user=request.user, amenity_id__in=amenity_ids
            ).values_list("amenity_id", flat=True)
        )

    # Serialize the individual amenities
    for a in amenities:
        final_amenities_list.append(
            serialize_map_amenity(
                a,
                request.user,
                favorite_amenity_ids=favorite_amenity_ids,
            )
        )

    return JsonResponse({"amenities": final_amenities_list})


@require_http_methods(["GET"])
def amenity_detail_api(request, amenity_id):
    try:
        amenity = (
            Amenity.objects.filter(id=amenity_id)
            .annotate(
                avg_rating=Avg("reviews__rating"),
                review_count=Count("reviews__id", distinct=True),
            )
            .annotate(
                primary_photo_url=Subquery(
                    AmenityPhoto.objects.filter(
                        amenity=OuterRef("pk"), is_primary=True
                    ).values("photo")[:1]
                )
            )
            .select_related("amenity_type")
            .prefetch_related(
                Prefetch(
                    "reviews", queryset=get_review_prefetch_queryset(request.user)
                ),
                "photos",
            )
            .get()
        )
    except Amenity.DoesNotExist:
        return JsonResponse({"error": "Amenity not found"}, status=404)

    favorite_ids = set()
    if request.user.is_authenticated:
        favorite_ids = set(
            Favorite.objects.filter(user=request.user, amenity=amenity).values_list(
                "amenity_id", flat=True
            )
        )

    return JsonResponse(
        {
            "amenity": serialize_map_amenity(
                amenity,
                request.user,
                favorite_amenity_ids=favorite_ids,
            )
        },
        status=200,
    )


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
        password = data.get("password", "").strip()

        if not email or not password:
            return JsonResponse({"error": "Email and password required"}, status=400)

        if CustomUser.objects.filter(email=email).exists():
            return JsonResponse({"error": "Email already registered"}, status=400)

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
        "is_authenticated": True,
    }


def serialize_amenity_review(review, photo_url=None, current_user=None):
    current_user_vote = getattr(review, "user_vote", 0)
    if not (current_user and current_user.is_authenticated):
        current_user_vote = 0

    return {
        "id": review.id,
        "amenity_id": review.amenity_id,
        "user_name": review.user.username or review.user.email,
        "user_email": review.user.email,
        "user_avatar_url": review.user.avatar_url,
        "rating": review.rating,
        "vote_score": int(getattr(review, "vote_score", 0)),
        "user_vote": int(current_user_vote or 0),
        "review_text": review.review_text,
        "photo_url": photo_url,
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
                "is_authenticated": False,
            },
            status=200,
        )

    return JsonResponse(serialize_auth_user(request.user), status=200)


@login_required(login_url="/?auth_required=1")
def profile_view(request):
    """
    Profile page.
    Anonymous users are redirected back to the map page.
    If a `user` query param (email) is provided, show that user's profile.
    """
    user_email = request.GET.get("user")
    if user_email:
        try:
            profile_user = CustomUser.objects.get(email=user_email)
        except CustomUser.DoesNotExist:
            profile_user = request.user
    else:
        profile_user = request.user

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
        },
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def change_password_api(request):
    """
    Change the current user's password while preserving the active session.
    """
    current_password = (request.POST.get("current_password") or "").strip()
    new_password = (request.POST.get("new_password") or "").strip()
    confirm_password = (request.POST.get("confirm_password") or "").strip()

    if not current_password or not new_password or not confirm_password:
        return JsonResponse({"error": "All password fields are required"}, status=400)

    if not request.user.check_password(current_password):
        return JsonResponse({"error": "Current password is incorrect"}, status=400)

    if new_password != confirm_password:
        return JsonResponse(
            {"error": "New password and confirmation do not match"},
            status=400,
        )

    if current_password == new_password:
        return JsonResponse(
            {"error": "New password must be different from your current password"},
            status=400,
        )

    request.user.set_password(new_password)
    request.user.save(update_fields=["password"])
    update_session_auth_hash(request, request.user)

    return JsonResponse({"message": "Password updated successfully"}, status=200)


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
    review_photo_url = None

    # Reuse prefetched amenity photos when available.
    # The current data model stores review photos on AmenityPhoto,
    # not directly on Review.
    for photo in review.amenity.photos.all():
        if photo.uploaded_by_id == review.user_id:
            review_photo_url = photo.photo.url
            break

    return {
        "id": review.id,
        "amenity_id": review.amenity_id,
        "amenity_name": review.amenity.name,
        "amenity_prop_name": review.amenity.prop_name,
        "amenity_type": review.amenity.amenity_type.name,
        "rating": review.rating,
        "review_text": review.review_text,
        "photo_url": review_photo_url,
        "created_at": review.created_at.isoformat(),
        "updated_at": review.updated_at.isoformat(),
    }


def serialize_profile_favorite(favorite):
    amenity = favorite.amenity
    return {
        "id": favorite.id,
        "amenity_id": amenity.id,
        "amenity_name": amenity.name,
        "amenity_prop_name": amenity.prop_name,
        "amenity_type": amenity.amenity_type.name,
        "address": amenity.address,
        "latitude": amenity.location.y,
        "longitude": amenity.location.x,
        "created_at": favorite.created_at.isoformat(),
    }


@login_required(login_url="/?auth_required=1")
@require_http_methods(["GET"])
def profile_reviews_api(request):
    """
    Return all reviews written by the given user for the profile page.
    Defaults to the current user; accepts an optional `user` query param (email).
    """
    user_email = request.GET.get("user")
    if user_email:
        try:
            target_user = CustomUser.objects.get(email=user_email)
        except CustomUser.DoesNotExist:
            target_user = request.user
    else:
        target_user = request.user

    reviews = (
        Review.objects.filter(user=target_user)
        .select_related("amenity")
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
    user_email = request.GET.get("user")
    if user_email:
        try:
            target_user = CustomUser.objects.get(email=user_email)
        except CustomUser.DoesNotExist:
            target_user = request.user
    else:
        target_user = request.user

    favorites = (
        Favorite.objects.filter(user=target_user)
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
@require_http_methods(["POST", "DELETE"])
def toggle_favorite_api(request, amenity_id):
    try:
        amenity = Amenity.objects.get(id=amenity_id)
    except Amenity.DoesNotExist:
        return JsonResponse({"error": "Amenity not found"}, status=404)

    if request.method == "POST":
        favorite, created = Favorite.objects.get_or_create(
            user=request.user,
            amenity=amenity,
        )
        return JsonResponse(
            {
                "amenity_id": amenity.id,
                "is_favorited": True,
                "message": "Added to favorites" if created else "Already favorited",
            },
            status=200,
        )

    Favorite.objects.filter(user=request.user, amenity=amenity).delete()
    return JsonResponse(
        {
            "amenity_id": amenity.id,
            "is_favorited": False,
            "message": "Removed from favorites",
        },
        status=200,
    )


@require_http_methods(["GET"])
def amenity_rating_distribution_api(request, amenity_id):
    """API endpoint to fetch the rating distribution for a specific amenity."""
    try:
        amenity = Amenity.objects.get(id=amenity_id)
    except Amenity.DoesNotExist:
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

        content_type = request.content_type or ""
        if content_type.startswith("multipart/form-data"):
            amenity_id = request.POST.get("amenity_id")
            rating = request.POST.get("rating", 5)
            review_text = request.POST.get("review_text", "").strip()
            photo_file = request.FILES.get("photo")
        else:
            data = json.loads(request.body)
            amenity_id = data.get("amenity_id")
            rating = data.get("rating", 5)
            review_text = data.get("review_text", "").strip()
            photo_file = None

        if not amenity_id:
            return JsonResponse({"error": "amenity_id required"}, status=400)

        try:
            rating = int(rating)
        except (TypeError, ValueError):
            return JsonResponse({"error": "Rating must be an integer"}, status=400)

        if not (1 <= rating <= 5):
            return JsonResponse({"error": "Rating must be between 1 and 5"}, status=400)

        if photo_file:
            content_type = photo_file.content_type or ""
            if not content_type.startswith("image/"):
                return JsonResponse({"error": "Photo must be an image"}, status=400)
            if photo_file.size > 5 * 1024 * 1024:
                return JsonResponse(
                    {"error": "Photo must be 5MB or smaller"}, status=400
                )

        try:
            amenity = Amenity.objects.get(id=amenity_id)
        except Amenity.DoesNotExist:
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

        review_photo = None
        if photo_file:
            review_photo = AmenityPhoto.objects.create(
                amenity=amenity,
                photo=photo_file,
                uploaded_by=user,
                is_primary=not AmenityPhoto.objects.filter(amenity=amenity).exists(),
                caption=f"Review photo by {user.email}",
            )

        response_data = serialize_amenity_review(
            review,
            photo_url=review_photo.photo.url if review_photo else None,
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

        vote_score = (
            ReviewVote.objects.filter(review=review).aggregate(
                total=Coalesce(Sum("value"), Value(0), output_field=IntegerField())
            )["total"]
            or 0
        )

        return JsonResponse(
            {
                "review_id": review.id,
                "vote_score": int(vote_score),
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
                .select_related("amenity")
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

        data = json.loads(request.body)
        rating = data.get("rating", review.rating)
        review_text = data.get("review_text", review.review_text)

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

        review.rating = rating
        review.review_text = review_text
        review.save(update_fields=["rating", "review_text", "updated_at"])

        refreshed_review = (
            Review.objects.filter(id=review.id)
            .select_related("amenity")
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
            amenity = Amenity.objects.get(id=amenity_id)
        except Amenity.DoesNotExist:
            return JsonResponse({"error": "Amenity not found"}, status=404)

        # Get all reviews for the amenity, ordered by most recent
        reviews = (
            Review.objects.filter(amenity=amenity)
            .select_related("user")
            .order_by("-created_at")
        )

        # Calculate pagination
        total_count = reviews.count()
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_reviews = reviews[start_idx:end_idx]

        # Serialize reviews
        reviews_data = [
            {
                "id": r.id,
                "user_name": r.user.email if r.user else "Anonymous",
                "rating": r.rating,
                "review_text": r.review_text,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
            for r in paginated_reviews
        ]

        return JsonResponse(
            {
                "amenity_id": amenity.id,
                "amenity_name": amenity.name,
                "total_reviews": total_count,
                "average_rating": amenity.get_average_rating(),
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
            # Get the last message
            last_message = chat.messages.last()

            other_user_email = None
            other_user_avatar = None
            if chat.chat_type == "direct":
                other_participant = chat.participants.exclude(user=request.user).first()
                if other_participant:
                    other_user_email = other_participant.user.email
                    other_user_avatar = other_participant.user.avatar_url

            chats_data.append(
                {
                    "id": chat.id,
                    "chat_type": chat.chat_type,
                    "name": chat.get_display_name(request.user),
                    "amenity_id": chat.amenity_id,
                    "amenity_name": chat.amenity.name if chat.amenity else None,
                    "created_by_email": chat.created_by.email,
                    "participant_count": chat.participants.count(),
                    "other_user_email": other_user_email,
                    "other_user_avatar": other_user_avatar,
                    "last_message": (
                        last_message.content[:100] if last_message else None
                    ),
                    "last_message_sender": (
                        last_message.sender.email if last_message else None
                    ),
                    "last_message_at": chat.last_message_at.isoformat(),
                    "created_at": chat.created_at.isoformat(),
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
        if not chat.participants.filter(user=request.user).exists():
            return JsonResponse(
                {"error": "You are not a participant in this chat"}, status=403
            )

        # Get messages with pagination
        messages = chat.messages.select_related("sender").order_by("-created_at")
        total_count = messages.count()
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_messages = messages[start_idx:end_idx]

        messages_data = [
            {
                "id": m.id,
                "sender_id": m.sender.id,
                "sender_email": m.sender.email,
                "content": m.content,
                "created_at": m.created_at.isoformat(),
            }
            for m in paginated_messages
        ]

        # Reverse to get chronological order
        messages_data.reverse()

        other_user_email = None
        other_user_avatar = None
        if chat.chat_type == "direct":
            other_participant = chat.participants.exclude(user=request.user).first()
            if other_participant:
                other_user_email = other_participant.user.email
                other_user_avatar = other_participant.user.avatar_url

        return JsonResponse(
            {
                "chat_id": chat.id,
                "chat_type": chat.chat_type,
                "chat_name": chat.get_display_name(request.user),
                "amenity_id": chat.amenity_id,
                "other_user_email": other_user_email,
                "other_user_avatar": other_user_avatar,
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
        content = data.get("content", "").strip()

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
        recipient_email = data.get("recipient_email", "").strip()

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
        chat_name = data.get("chat_name", "").strip()
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
                amenity = Amenity.objects.get(id=amenity_id)
            except Amenity.DoesNotExist:
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


@require_http_methods(["GET"])
def get_chat_participants_api(request):
    """Return all participants for a chat the current user belongs to."""
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Login required"}, status=401)

    chat_id = request.GET.get("chat_id")
    if not chat_id:
        return JsonResponse({"error": "chat_id required"}, status=400)

    try:
        chat = Chat.objects.get(id=chat_id)
    except Chat.DoesNotExist:
        return JsonResponse({"error": "Chat not found"}, status=404)

    if not chat.participants.filter(user=request.user).exists():
        return JsonResponse({"error": "You are not a participant"}, status=403)

    participants = chat.participants.select_related("user").all()
    return JsonResponse(
        {
            "participants": [
                {
                    "email": p.user.email,
                    "username": p.user.username or p.user.email,
                    "avatar_url": p.user.avatar_url,
                }
                for p in participants
            ]
        }
    )


@csrf_exempt
@login_required(login_url="/?auth_required=1")
@require_http_methods(["POST"])
def leave_chat_api(request):
    """Remove the current user from a group chat."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    chat_id = data.get("chat_id")
    if not chat_id:
        return JsonResponse({"error": "chat_id required"}, status=400)

    try:
        chat = Chat.objects.get(id=chat_id)
    except Chat.DoesNotExist:
        return JsonResponse({"error": "Chat not found"}, status=404)

    if chat.chat_type == "direct":
        return JsonResponse({"error": "Cannot leave a direct chat"}, status=400)

    deleted, _ = ChatParticipant.objects.filter(chat=chat, user=request.user).delete()
    if not deleted:
        return JsonResponse({"error": "You are not a participant"}, status=403)

    return JsonResponse({"success": True})


@require_http_methods(["GET"])
def amenity_search_api(request):
    """Search amenities by name for group chat creation."""
    q = request.GET.get("q", "").strip()
    limit = min(int(request.GET.get("limit", 10)), 20)

    if len(q) < 2:
        return JsonResponse({"amenities": []})

    amenities = (
        Amenity.objects.filter(name__icontains=q, active=True)
        .select_related("amenity_type")
        .order_by("name")[:limit]
    )

    return JsonResponse(
        {
            "amenities": [
                {
                    "id": a.id,
                    "name": a.name,
                    "address": a.address or "",
                    "type": a.amenity_type.name,
                }
                for a in amenities
            ]
        }
    )


@require_http_methods(["GET"])
def get_amenity_reviewers_api(request):
    """Get list of recent reviewers for an amenity (for starting group chats)."""
    try:
        amenity_id = request.GET.get("amenity_id")
        limit = int(request.GET.get("limit", 10))

        if not amenity_id:
            return JsonResponse({"error": "amenity_id parameter required"}, status=400)

        try:
            amenity = Amenity.objects.get(id=amenity_id)
        except Amenity.DoesNotExist:
            return JsonResponse({"error": "Amenity not found"}, status=404)

        # Get recent reviewers
        reviewers = (
            Review.objects.filter(amenity=amenity, user__isnull=False)
            .select_related("user")
            .order_by("-created_at")[:limit]
        )

        reviewers_data = [
            {
                "user_id": r.user.id,
                "email": r.user.email,
                "rating": r.rating,
                "review_text": r.review_text[:100] if r.review_text else None,
                "created_at": r.created_at.isoformat(),
            }
            for r in reviewers
        ]

        return JsonResponse(
            {
                "amenity_id": amenity.id,
                "amenity_name": amenity.name,
                "reviewers": reviewers_data,
                "total_reviewers": len(reviewers_data),
            },
            status=200,
        )

    except (ValueError, TypeError):
        return JsonResponse({"error": "Invalid limit parameter"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)
