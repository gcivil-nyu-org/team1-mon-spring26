from django.http import JsonResponse
from .models import Amenity


def index(request):
    amenities = Amenity.objects.select_related("amenity_type").filter(active=True)
    data = {
        "count": amenities.count(),
        "amenities": [
            {
                "id": a.id,
                "name": a.name,
                "type": a.amenity_type.name,
                "latitude": float(a.latitude),
                "longitude": float(a.longitude),
                "description": a.description,
                "operator": a.operator,
                "hours_of_operation": a.hours_of_operation,
                "accessibility": a.accessibility,
                "active": a.active,
            }
            for a in amenities
        ],
    }
    return JsonResponse(data)
