from django.shortcuts import render
from django.http import JsonResponse
from .models import Amenity, AmenityType
from django.views.decorators.http import require_GET

# Create your views here.

def _is_true(value: str) -> bool:
    return str(value).lower() in {"1", "true", "yes", "y", "on"}

def map_view(request):
    return render(request, 'maps/map.html')

@require_GET
def amenities_api(request):
    qs = Amenity.objects.select_related("amenity_type").all()

    type_ids = [x for x in request.GET.getlist("type_id") if x.isdigit()]
    if type_ids:
        qs = qs.filter(amenity_type_id__in=type_ids)
    
    #default show all
    if _is_true(request.GET.get("only_accessible", "0")):
        qs = qs.filter(accessibility="Fully Accessible")

    #by default do not include inactive, only show active amenities 
    
    if not _is_true(request.GET.get("include_inactive", "0")):
        qs = qs.filter(active=True)
    
    north = request.GET.get("north")
    south = request.GET.get("south")
    east = request.GET.get("east")
    west = request.GET.get("west")
    
    if all(v is not None for v in [north, south, east, west]):
        try:
            n, s, e, w = map(float, [north, south, east, west])
        except ValueError:
            return JsonResponse({"error": "Invalid bbox params"}, status=400)
        qs = qs.filter(
            latitude__gte=s,
            latitude__lte=n,
            longitude__gte=w,
            longitude__lte=e,
        )

    data = {
        'amenities': [
            {
                "id": amenity.id,
                "name": amenity.name,
                "latitude": float(amenity.latitude),
                "longitude": float(amenity.longitude),
                "type": amenity.amenity_type.name,
                "type_id": amenity.amenity_type_id,
                "icon": amenity.amenity_type.icon,
                "color": amenity.amenity_type.color,
                "address": amenity.address,
                "description": amenity.description,
                "active": amenity.active,
                "accessibility": amenity.accessibility,
            }
            for amenity in qs
        ]
    }
    return JsonResponse(data)

@require_GET
def amenity_types_api(request):
    roots = (
        AmenityType.objects
        .filter(parent__isnull=True)
        .prefetch_related("sub_types")
        .order_by("name")
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
                    for st in t.sub_types.all().order_by("name")
                ],
            }
            for t in roots
        ]
    }
    return JsonResponse(data)

