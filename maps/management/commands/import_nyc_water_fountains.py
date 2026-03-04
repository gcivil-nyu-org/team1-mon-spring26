import requests
import time
from django.core.management.base import BaseCommand
from django.contrib.gis.geos import GEOSGeometry
from django.db import transaction
from maps.models import AmenityType, Amenity


class Command(BaseCommand):
    help = "Import NYC water fountains from NYC Open Data"

    def handle(self, *args, **options):
        self.stdout.write("Starting NYC water fountains import...")

        # Create or get the Water Fountain amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name="Water Fountain", defaults={"color": "#00BCD4", "icon": "droplet"}
        )

        if created:
            self.stdout.write(
                self.style.SUCCESS(f"Created amenity type: {amenity_type.name}")
            )

        # NYC Open Data OData v4 endpoint
        url = "https://data.cityofnewyork.us/api/odata/v4/qnv7-p7a2"

        try:
            self.stdout.write(f"Fetching data from: {url}")

            # Define your query parameters
            query_params = {
                "$top": 10000,  # Limit to 10k rows
                "$skip": 0,  # Start at the beginning
                "$count": "true",  # Get total record count
            }

            response = requests.get(url, params=query_params, timeout=60)
            response.raise_for_status()

            data = response.json()

            # OData v4 format has results in 'value' key
            if "value" not in data:
                self.stdout.write(self.style.ERROR("Invalid OData response format"))
                return

            fountains = data["value"]
            self.stdout.write(f"Found {len(fountains)} water fountains")

            created_count = 0
            updated_count = 0
            skipped_count = 0

            with transaction.atomic():
                for fountain in fountains:
                    try:
                        # OData format
                        if not isinstance(fountain, dict):
                            skipped_count += 1
                            continue

                        # Extract basic info
                        propnum = fountain.get('gispropnum', '')
                        external_id = (
                            fountain.get("system")
                            or fountain.get("_id")
                            or fountain.get("ID")
                            or f"{propnum}_{int(time.time() * 1000)}"
                        )
                        name = (
                            fountain.get("Location")
                            or fountain.get("location")
                            or "Water Fountain"
                        )
                        position = (
                            fountain.get("Position") or fountain.get("position") or ""
                        )
                        prop_name = (
                            fountain.get("propertyna")
                            or fountain.get("PropName")
                            or fountain.get("propName")
                            or fountain.get("prop_name")
                            or ""
                        )

                        # Check active status
                        active = True
                        if "Active" in fountain:
                            active_str = str(fountain["Active"]).lower()
                            active = active_str in ["true", "yes", "1", "y", "active"]

                        geom = fountain["the_geom"]

                        # use composite key (amenity_type, external_id)
                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                "name": str(name)[:200],
                                "location": GEOSGeometry(str(geom)),
                                "description": str(position)[:500],
                                "prop_name": str(prop_name)[:200],
                                "active": active,
                            },
                        )

                        if created:
                            created_count += 1
                        else:
                            updated_count += 1

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(self.style.WARNING(f"Skipped entry: {e}"))
                        skipped_count += 1
                        continue

            self.stdout.write(
                self.style.SUCCESS(
                    f"\nImport complete!\n"
                    f"Created: {created_count}\n"
                    f"Updated: {updated_count}\n"
                    f"Skipped: {skipped_count}"
                )
            )

        except requests.exceptions.RequestException as e:
            self.stdout.write(self.style.ERROR(f"Failed to fetch data: {e}"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Import failed: {e}"))
