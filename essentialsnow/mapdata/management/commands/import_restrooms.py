import requests
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction
from mapdata.models import AmenityType, Amenity


class Command(BaseCommand):
    help = "Import NYC public restrooms from NYC Open Data"

    def handle(self, *args, **options):
        amenity_type, _ = AmenityType.objects.get_or_create(
            name="Public Restroom", defaults={"color": "#9C27B0", "icon": "restroom"}
        )

        url = "https://data.cityofnewyork.us/api/odata/v4/i7jb-7jku"
        response = requests.get(url, params={"$top": 10000, "$skip": 0}, timeout=60)
        response.raise_for_status()
        restrooms = response.json().get("value", [])
        self.stdout.write(f"Found {len(restrooms)} restrooms")

        created, updated, skipped = 0, 0, 0

        with transaction.atomic():
            for r in restrooms:
                try:
                    lat = lon = None
                    if "latitude" in r and "longitude" in r:
                        lat = Decimal(str(r["latitude"]))
                        lon = Decimal(str(r["longitude"]))
                    if not lat or not lon:
                        geom = r.get("location_1", {})
                        if isinstance(geom, dict) and "coordinates" in geom:
                            lon, lat = Decimal(str(geom["coordinates"][0])), Decimal(
                                str(geom["coordinates"][1])
                            )

                    if not lat or not lon:
                        skipped += 1
                        continue

                    external_id = str(r.get("__id") or f"{lat}_{lon}")
                    acc_raw = str(r.get("accessibility", "")).lower()
                    if "fully" in acc_raw:
                        accessibility = "Fully Accessible"
                    elif "partial" in acc_raw:
                        accessibility = "Partially Accessible"
                    elif "not" in acc_raw:
                        accessibility = "Not Accessible"
                    else:
                        accessibility = ""

                    _, was_created = Amenity.objects.update_or_create(
                        amenity_type=amenity_type,
                        external_id=external_id,
                        defaults={
                            "name": str(r.get("facility_name") or "Public Restroom")[
                                :200
                            ],
                            "latitude": lat,
                            "longitude": lon,
                            "operator": str(r.get("operator", ""))[:200],
                            "hours_of_operation": str(r.get("hours_of_operation", ""))[
                                :500
                            ],
                            "changing_stations": str(
                                r.get("changing_stations", "")
                            ).lower()
                            in ["true", "yes", "1"],
                            "accessibility": accessibility,
                            "active": str(r.get("status", "true")).lower()
                            in ["true", "yes", "1", "open", "available", "operational"],
                        },
                    )
                    if was_created:
                        created += 1
                    else:
                        updated += 1
                except Exception as e:
                    self.stdout.write(self.style.WARNING(f"Skipped: {e}"))
                    skipped += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Done. Created: {created}, Updated: {updated}, Skipped: {skipped}"
            )
        )
