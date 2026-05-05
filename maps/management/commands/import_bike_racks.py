import requests
from django.core.management.base import BaseCommand
from django.conf import settings
from maps.models import AmenityType, Amenity
import boto3
import geohash2
from decimal import Decimal
from botocore.config import Config


def get_dynamodb_table():
    kwargs = {"region_name": settings.DYNAMODB_REGION}
    if getattr(settings, "DYNAMODB_ENDPOINT_URL", None):
        kwargs["endpoint_url"] = settings.DYNAMODB_ENDPOINT_URL
    config = Config(retries={"max_attempts": 50, "mode": "adaptive"})
    dynamodb = boto3.resource("dynamodb", config=config, **kwargs)
    return dynamodb.Table(settings.DYNAMODB_TABLE_NAME)


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

            processed_count = 0
            skipped_count = 0

            table = get_dynamodb_table()

            existing_racks = {
                a.external_id: a
                for a in Amenity.objects.filter(amenity_type=amenity_type)
            }
            to_create = []
            to_update = []

            for i, rack in enumerate(racks):
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

                    lon = geom_dict["coordinates"][0]
                    lat = geom_dict["coordinates"][1]

                    external_id = str(
                        rack.get("site_id") or f"bikerack_{lon}_{lat}"
                    )

                    ifo_address = rack.get("ifoaddress", "")
                    name = rack.get("ntaname") or ifo_address or "Bike Rack"
                    rack_type_desc = rack.get("racktype", "Standard Rack")
                    description = f"Type: {rack_type_desc}"

                    location_hash = geohash2.encode(
                        float(lat), float(lon), precision=6
                    )

                    item = {
                        "PK": f"AMENITY#{external_id}",
                        "SK": f"AMENITY#{external_id}",
                        "GSI1PK": f"GEOHASH#{location_hash}",
                        "GSI1SK": "TYPE#Bike Rack#ACTIVE#True",
                        "Id": external_id,
                        "Name": name,
                        "Type": "Bike Rack",
                        "Address": ifo_address,
                        "Description": description,
                        "Latitude": Decimal(str(lat)),
                        "Longitude": Decimal(str(lon)),
                        "Active": True,
                        "AverageRating": Decimal("0"),
                        "ReviewCount": 0,
                    }
                    table.put_item(Item=item)
                    processed_count += 1

                    if external_id in existing_racks:
                        obj = existing_racks[external_id]
                        obj.name = name[:200]
                        obj.latitude = float(lat)
                        obj.longitude = float(lon)
                        obj.active = True
                        to_update.append(obj)
                    else:
                        to_create.append(
                            Amenity(
                                amenity_type=amenity_type,
                                external_id=external_id,
                                name=name[:200],
                                latitude=float(lat),
                                longitude=float(lon),
                                active=True,
                            )
                        )

                except (ValueError, IndexError, TypeError, KeyError) as e:
                    self.stdout.write(
                        self.style.WARNING(f"Skipped entry: {e} - {rack}")
                    )
                    skipped_count += 1
                    continue

            if to_create:
                Amenity.objects.bulk_create(to_create, batch_size=1000)
            if to_update:
                Amenity.objects.bulk_update(
                    to_update,
                    ["name", "latitude", "longitude", "active"],
                    batch_size=1000,
                )

            self.stdout.write(
                self.style.SUCCESS(
                    f"\nImport complete!\n"
                    f"Processed (upserted): {processed_count}\n"
                    f"Skipped: {skipped_count}"
                )
            )

        except requests.exceptions.RequestException as e:
            self.stdout.write(self.style.ERROR(f"Failed to fetch data: {e}"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"An unexpected error occurred: {e}"))
