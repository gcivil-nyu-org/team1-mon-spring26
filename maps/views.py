from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate
from django.contrib.gis.geos import Polygon
from .models import AmenityType, Amenity, Review, AmenityPhoto, CustomUser, Review
from django.db.models import Q, Avg, Count, Subquery, OuterRef
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
    return render(request, 'maps/map.html', {
        'amenity_types': amenity_types
    })


def amenities_api(request):
    """API endpoint to fetch amenities, optionally filtered by type and bounding box."""
    amenity_type_ids = request.GET.getlist('type_id')
    amenity_type_name = request.GET.get('type')
    include_inactive = request.GET.get('include_inactive', 'false').lower() == 'true'
    only_accessible = request.GET.get('only_accessible', 'false').lower() == 'true'
    
    # Get bounding box parameters (from map pan/zoom)
    try:
        north = request.GET.get('north')
        south = request.GET.get('south')
        east = request.GET.get('east')
        west = request.GET.get('west')
        
        # If bounding box is provided, use it for filtering
        if north and south and east and west:
            north = Decimal(north)
            south = Decimal(south)            
            east = Decimal(east)
            west = Decimal(west)

            # Create a Polygon object for the bounding box
            bbox = (west, south, east, north)
            amenities = Amenity.objects.filter(location__bboverlaps=Polygon.from_bbox(bbox))

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
        amenities = amenities.exclude(accessibility='Not Accessible')
    
    # --- Performance Optimization: Annotate data at the database level ---
    
    # 1. Annotate average rating and review count
    amenities = amenities.annotate(
        avg_rating=Avg('reviews__rating'),
        review_count=Count('reviews__id', distinct=True)
    )

    # 2. Use a Subquery to efficiently get the primary photo URL
    primary_photo_subquery = AmenityPhoto.objects.filter(
        amenity=OuterRef('pk'), 
        is_primary=True
    ).values('photo')[:1]
    
    amenities = amenities.annotate(
        primary_photo_url=Subquery(primary_photo_subquery)
    )
    data = {
        'amenities': [
            {
                'id': a.id,
                'name': a.name,
                'latitude': a.location.y,
                'longitude': a.location.x,
                'address': a.address,
                'prop_name': a.prop_name,
                'description': a.description,
                'operator': a.operator,
                'hours_of_operation': a.hours_of_operation,
                'changing_stations': a.changing_stations,
                'accessibility': a.accessibility,
                'rating': a.avg_rating,
                'review_count': a.review_count,
                'reviews': [
                    {
                        'user_name': r.user.email,
                        'rating': r.rating,
                        'review_text': r.review_text,
                        'created_at': r.created_at.isoformat(),
                    }
                    for r in a.reviews.all()[:5]  # Get last 5 reviews
                ],
                'photo_url': a.primary_photo_url,
                'active': a.active,
                'type': a.amenity_type.name,
                'type_id': a.amenity_type.id,
                'icon': a.amenity_type.icon,
                'color': a.amenity_type.color,
            }
            for a in amenities.select_related('amenity_type').prefetch_related('reviews__user')
        ]
    }
    return JsonResponse(data)


def amenity_types_api(request):
    """API endpoint to fetch all amenity types."""
    # Fetch only top-level types (those without a parent)
    top_level_types = AmenityType.objects.filter(parent__isnull=True).prefetch_related('sub_types')
    
    data = {
        'types': [
            {
                'id': t.id,
                'name': t.name,
                'color': t.color,
                'icon': t.icon,
                'sub_types': [
                    {
                        'id': st.id,
                        'name': st.name,
                        'color': st.color,
                        'icon': st.icon,
                    } for st in t.sub_types.all()
                ]
            }
            for t in top_level_types
        ]
    }
    return JsonResponse(data)


@csrf_exempt
@require_http_methods(['POST'])
def register_api(request):
    """API endpoint for user registration."""
    try:
        data = json.loads(request.body)
        email = data.get('email', '').strip()
        password = data.get('password', '').strip()
        
        if not email or not password:
            return JsonResponse({'error': 'Email and password required'}, status=400)
        
        if CustomUser.objects.filter(email=email).exists():
            return JsonResponse({'error': 'Email already registered'}, status=400)
        
        # Create user with email as username and custom fields
        user = CustomUser.objects.create_user(
            username=email,
            email=email,
            password=password
        )
        
        return JsonResponse({
            'id': user.id,
            'email': user.email,
            'message': 'User registered successfully'
        }, status=201)
    
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
@require_http_methods(['POST'])
def login_api(request):
    """API endpoint for user login."""
    try:
        data = json.loads(request.body)
        email = data.get('email', '').strip()
        password = data.get('password', '').strip()
        
        if not email or not password:
            return JsonResponse({'error': 'Email and password required'}, status=400)
        
        # Since username field is email, authenticate with email
        user = authenticate(request, username=email, password=password)
        
        if user is None:
            return JsonResponse({'error': 'Invalid email or password'}, status=401)
        
        return JsonResponse({
            'id': user.id,
            'email': user.email,
            'message': 'Login successful'
        }, status=200)
    
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
@require_http_methods(['POST'])
def create_review_api(request):
    """API endpoint for submitting reviews."""
    try:
        # For now, we'll require email in the request since we don't have session/token auth yet
        data = json.loads(request.body)
        amenity_id = data.get('amenity_id')
        email = data.get('email', '').strip()
        rating = data.get('rating')
        review_text = data.get('review_text', '').strip()
        
        if not all([amenity_id, email, rating]):
            return JsonResponse({'error': 'amenity_id, email, and rating required'}, status=400)
        
        if not (1 <= rating <= 5):
            return JsonResponse({'error': 'Rating must be between 1 and 5'}, status=400)
        
        try:
            amenity = Amenity.objects.get(id=amenity_id)
        except Amenity.DoesNotExist:
            return JsonResponse({'error': 'Amenity not found'}, status=404)
        
        try:
            user = CustomUser.objects.get(email=email)
        except CustomUser.DoesNotExist:
            return JsonResponse({'error': 'User not found. Please register first.'}, status=404)
        
        # Check if user already has a review for this amenity
        if Review.objects.filter(amenity=amenity, user=user).exists():
            return JsonResponse({'error': 'You have already reviewed this amenity'}, status=400)
        
        review = Review.objects.create(
            amenity=amenity,
            user=user,
            rating=rating,
            review_text=review_text
        )
        
        return JsonResponse({
            'id': review.id,
            'amenity_id': amenity.id,
            'rating': review.rating,
            'review_text': review.review_text,
            'created_at': review.created_at.isoformat(),
            'message': 'Review created successfully'
        }, status=201)
    
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)
