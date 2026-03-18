from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.contrib.gis.geos import Polygon, GEOSGeometry
from .models import AmenityType, Amenity, Review, AmenityPhoto, CustomUser
from django.db.models import Avg, Count, Subquery, OuterRef
from decimal import Decimal
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
    except (ValueError, TypeError):
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
    amenities = amenities.select_related("amenity_type").prefetch_related(
        "reviews__user", "photos"
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

    # Serialize the individual amenities
    for a in amenities:
        photo_by_user = {}
        for p in a.photos.all():
            if p.uploaded_by_id not in photo_by_user:
                photo_by_user[p.uploaded_by_id] = p.photo.url

        final_amenities_list.append(
            {
                "id": a.id,
                "name": a.name,
                "latitude": a.location.y,
                "longitude": a.location.x,
                "address": a.address,
                "prop_name": a.prop_name,
                "description": a.description,
                "operator": a.operator,
                "hours_of_operation": a.hours_of_operation,
                "changing_stations": a.changing_stations,
                "accessibility": a.accessibility,
                "rating": a.avg_rating,
                "review_count": a.review_count,
                "reviews": [
                    {
                        "user_name": r.user.email,
                        "rating": r.rating,
                        "review_text": r.review_text,
                        "photo_url": photo_by_user.get(r.user_id),
                        "created_at": r.created_at.isoformat(),
                    }
                    for r in a.reviews.all()[:5]  # Get last 5 reviews
                ],
                "photo_url": a.primary_photo_url,
                "active": a.active,
                "type": a.amenity_type.name,
                "type_id": a.amenity_type.id,
                "icon": a.amenity_type.icon,
                "color": a.amenity_type.color,
            }
        )

    return JsonResponse({"amenities": final_amenities_list})


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
        "is_authenticated": True,
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
    """
    return render(
        request,
        "maps/profile.html",
        {
            "profile_user": request.user,
        },
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

        return JsonResponse(
            {
                "id": review.id,
                "amenity_id": amenity.id,
                "user_name": user.email,
                "rating": review.rating,
                "review_text": review.review_text,
                "photo_url": review_photo.photo.url if review_photo else None,
                "created_at": review.created_at.isoformat(),
                "message": "Review created successfully",
            },
            status=201,
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)
