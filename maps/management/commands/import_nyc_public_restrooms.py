from decimal import Decimal
import json
from urllib.request import urlopen

from django.core.management.base import BaseCommand
from django.db import transaction

from maps.models import Amenity, AmenityType


class Command(BaseCommand):
    help = "Import NYC public restroom data from NYC Open Data"

    DATA_URL = "https://data.cityofnewyork.us/api/odata/v4/i7jb-7jku?$top=10000&$count=true"

    def handle(self, *args, **options):
        amenity_type, _ = AmenityType.objects.get_or_create(
            name="Restroom",
            defaults={
                "icon": "restroom",
                "color": "#2E86AB",
            },
        )

        self.stdout.write(f"Fetching data from {self.DATA_URL}")

        with urlopen(self.DATA_URL, timeout=60) as response:
            data = json.load(response)

        rows = data.get("value", [])
        self.stdout.write(f"Fetched {len(rows)} rows")

        created_count = 0
        updated_count = 0
        skipped_count = 0

        with transaction.atomic():
            for row in rows:
                try:
                    external_id = str(row.get("__id") or "").strip()
                    latitude = row.get("latitude")
                    longitude = row.get("longitude")

                    if not external_id or latitude is None or longitude is None:
                        skipped_count += 1
                        continue

                    name = (row.get("facility_name") or "Public Restroom").strip()
                    location_type = (row.get("location_type") or "").strip()
                    restroom_type = (row.get("restroom_type") or "").strip()
                    notes = (row.get("additional_notes") or "").strip()
                    operator = (row.get("operator") or "").strip()
                    accessibility_raw = (row.get("accessibility") or "").strip()
                    status_raw = (row.get("status") or "").strip().lower()
                    open_raw = (row.get("open") or "").strip().lower()
                    hours_raw = (row.get("hours_of_operation") or "").strip()
                    changing_raw = str(row.get("changing_stations") or "").strip().lower()

                    description_parts = [x for x in [location_type, restroom_type, notes] if x]
                    description = " | ".join(description_parts)

                    if "fully" in accessibility_raw.lower():
                        accessibility = "Fully Accessible"
                    elif "partial" in accessibility_raw.lower():
                        accessibility = "Partially Accessible"
                    elif "not" in accessibility_raw.lower():
                        accessibility = "Not Accessible"
                    else:
                        accessibility = ""

                    active = status_raw == "operational"
                    seasonal = open_raw == "seasonal"
                    changing_stations = "yes" in changing_raw or changing_raw in {"true", "1"}

                    obj, created = Amenity.objects.update_or_create(
                        amenity_type=amenity_type,
                        external_id=external_id,
                        defaults={
                            "name": name[:200],
                            "latitude": Decimal(str(latitude)),
                            "longitude": Decimal(str(longitude)),
                            "address": "",
                            "prop_name": location_type[:200],
                            "description": description,
                            "operator": operator[:200],
                            "hours_of_operation": {"raw": hours_raw} if hours_raw else {},
                            "changing_stations": changing_stations,
                            "accessibility": accessibility,
                            "active": active,
                            "seasonal": seasonal,
                        },
                    )

                    if created:
                        created_count += 1
                    else:
                        updated_count += 1

                except Exception as exc:
                    skipped_count += 1
                    self.stdout.write(self.style.WARNING(f"Skipped row: {exc}"))

        self.stdout.write(
            self.style.SUCCESS(
                f"Done. created={created_count}, updated={updated_count}, skipped={skipped_count}"
            )
        )