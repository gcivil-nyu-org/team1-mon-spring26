import requests
from django.core.management.base import BaseCommand
from django.contrib.gis.geos import GEOSGeometry
from maps.models import AmenityType, Amenity
import json


class Command(BaseCommand):
    help = "Import NYC bike racks from NYC Open Data"

    def handle(self, *args, **options):
        self.stdout.write("Starting NYC bike racks import...")

        # Create or get the Bike Rack amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name="Bike Rack", defaults={"color": "#FF9800", "icon": "bicycle"}  # Orange
        )

        if created:
            self.stdout.write(
                self.style.SUCCESS(f"Created amenity type: {amenity_type.name}")
            )

        # NYC Open Data OData v4 endpoint for bike racks
        url = "https://data.cityofnewyork.us/api/odata/v4/592z-n7dk"

        try:
            self.stdout.write(f"Fetching data from: {url}")

            query_params = {
                "$top": 100000,  # A large number to get all racks
                "$skip": 0,
                "$count": "true",
            }

            response = requests.get(url, params=query_params, timeout=120)
            response.raise_for_status()

            data = response.json()

            if "value" not in data:
                self.stdout.write(self.style.ERROR("Invalid OData response format"))
                return

            racks = data["value"]
            self.stdout.write(f"Found {len(racks)} bike racks")

            created_count = 0
            updated_count = 0
            skipped_count = 0

            # --- Bulk Operation Optimization ---
            # 1. Fetch existing racks into a dictionary for quick lookups.
            self.stdout.write("Fetching existing bike racks from database...")
            existing_racks = {
                a.external_id: a
                for a in Amenity.objects.filter(amenity_type=amenity_type)
            }
            self.stdout.write(f"Found {len(existing_racks)} existing racks.")

            to_create = []
            to_update = []

            for i, rack in enumerate(racks):
                # Add a progress indicator
                if i > 0 and i % 1000 == 0:
                    self.stdout.write(f"  Processed {i}/{len(racks)} racks...")

                try:
                    if not isinstance(rack, dict):
                        skipped_count += 1
                        continue

                    geom_dict = rack.get("the_geom")
                    if not geom_dict or "coordinates" not in geom_dict:
                        skipped_count += 1
                        continue

                    y = geom_dict["coordinates"][0]
                    x = geom_dict["coordinates"][1]

                    external_id = str(
                        rack.get("site_id")
                        or f"bikerack_{x}_{y}"
                    )

                    ifo_address = rack.get("ifoaddress", "")
                    name = rack.get("ntaname") or ifo_address or "Bike Rack"
                    rack_type_desc = rack.get("racktype", "Standard Rack")
                    location = GEOSGeometry(json.dumps(geom_dict))
                    description = f"Type: {rack_type_desc}"

                    # 2. if rack exists sort it into a create or update list.
                    if external_id in existing_racks:
                        # It's an update
                        obj = existing_racks[external_id]
                        obj.name = name
                        obj.address = ifo_address
                        obj.location = location
                        obj.description = description
                        obj.active = True
                        to_update.append(obj)
                        updated_count += 1
                    else:
                        # It's a new rack
                        to_create.append(
                            Amenity(
                                amenity_type=amenity_type,
                                external_id=external_id,
                                name=name,
                                address=ifo_address,
                                location=location,
                                description=description,
                                active=True,
                            )
                        )
                        created_count += 1

                except (ValueError, IndexError, TypeError, KeyError) as e:
                    self.stdout.write(
                        self.style.WARNING(f"Skipped entry: {e} - {rack}")
                    )
                    skipped_count += 1
                    continue

            # 3. Perform bulk operations outside the loop.
            if to_create:
                self.stdout.write(f"Bulk creating {len(to_create)} new bike racks...")
                Amenity.objects.bulk_create(to_create, batch_size=1000)

            if to_update:
                self.stdout.write(
                    f"Bulk updating {len(to_update)} existing bike racks..."
                )
                Amenity.objects.bulk_update(
                    to_update,
                    ["name", "address", "location", "description", "active"],
                    batch_size=1000,
                )

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
            self.stdout.write(self.style.ERROR(f"An unexpected error occurred: {e}"))
