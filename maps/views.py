from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate
from .models import AmenityType, Amenity, Review, AmenityPhoto, CustomUser
from django.db.models import Q
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
    amenity_type_id = request.GET.get('type_id')
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
            # Normalize longitude values to handle map wrapping
            east = normalize_longitude(Decimal(east))
            west = normalize_longitude(Decimal(west))

            # Base query for latitude
            amenities = Amenity.objects.filter(latitude__gte=south, latitude__lte=north)

            # Always use a simple longitude filter with the normalized coordinates
            amenities = amenities.filter(longitude__gte=west, longitude__lte=east)

        else:
            amenities = Amenity.objects.all()
    except (ValueError, TypeError):
        amenities = Amenity.objects.all()
    
    # Filter by amenity type if specified
    if amenity_type_id:
        amenities = amenities.filter(amenity_type_id=amenity_type_id)
    elif amenity_type_name:
        # Allow filtering by type name as well
        amenities = amenities.filter(amenity_type__name__iexact=amenity_type_name)
    
    # Filter by active status unless explicitly showing inactive
    if not include_inactive:
        amenities = amenities.filter(active=True)
    
    # Filter by accessibility if requested
    if only_accessible:
        amenities = amenities.exclude(accessibility='Not Accessible')
    
    data = {
        'amenities': [
            {
                'id': a.id,
                'name': a.name,
                'latitude': float(a.latitude),
                'longitude': float(a.longitude),
                'address': a.address,
                'prop_name': a.prop_name,
                'description': a.description,
                'operator': a.operator,
                'hours_of_operation': a.hours_of_operation,
                'changing_stations': a.changing_stations,
                'accessibility': a.accessibility,
                'rating': a.get_average_rating(),
                'review_count': a.get_review_count(),
                'reviews': [
                    {
                        'user_name': r.user.email,
                        'rating': r.rating,
                        'review_text': r.review_text,
                        'created_at': r.created_at.isoformat(),
                    }
                    for r in a.reviews.all()[:5]  # Get last 5 reviews
                ],
                'photo_url': a.photos.filter(is_primary=True).first().photo.url if a.photos.filter(is_primary=True).exists() else None,
                'active': a.active,
                'type': a.amenity_type.name,
                'type_id': a.amenity_type.id,
                'icon': a.amenity_type.icon,
                'color': a.amenity_type.color,
            }
            for a in amenities.select_related('amenity_type').prefetch_related('reviews', 'photos')
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
