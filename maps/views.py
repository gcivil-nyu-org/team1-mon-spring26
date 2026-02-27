from django.shortcuts import render
from django.http import JsonResponse
from .models import Amenity

# Create your views here.

def map_view(request):
    return render(request, 'maps/map.html')

def amenities_api(request):
    amenities = Amenity.objects.all()
    data = {
        'amenities': [
            {
                'id': amenity.id,
                'name': amenity.name,
                'latitude': float(amenity.latitude),
                'longitude': float(amenity.longitude),

            }
            for amenity in amenities
        ]
    }
    return JsonResponse(data)