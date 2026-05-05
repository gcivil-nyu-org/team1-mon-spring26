import requests
from decimal import Decimal, InvalidOperation
from django.core.management.base import BaseCommand
from django.conf import settings
from maps.models import AmenityType, Amenity
import stateplane
import boto3
import geohash2
from botocore.config import Config


def get_dynamodb_table():
    kwargs = {"region_name": settings.DYNAMODB_REGION}
    if getattr(settings, "DYNAMODB_ENDPOINT_URL", None):
        kwargs["endpoint_url"] = settings.DYNAMODB_ENDPOINT_URL
    config = Config(retries={"max_attempts": 50, "mode": "adaptive"})
    dynamodb = boto3.resource("dynamodb", config=config, **kwargs)
    return dynamodb.Table(settings.DYNAMODB_TABLE_NAME)


class Command(BaseCommand):
    help = "Import NYC cooling sites from NYC Open Data"

    def handle(self, *args, **options):
        self.stdout.write("Starting NYC cooling sites import...")

        # Create the main parent "Cooling Sites" amenity type
        parent_amenity_type, created = AmenityType.objects.get_or_create(
            name="Cooling Sites",
            defaults={"color": "#1E88E5", "icon": "snowflake"},  # A cool blue
        )
        if created:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Created parent amenity type: {parent_amenity_type.name}"
                )
            )

        # OData v4 endpoint for cooling sites
        url = "https://data.cityofnewyork.us/api/odata/v4/h2bn-gu9k"

        try:
            self.stdout.write(f"Fetching data from: {url}")

            query_params = {
                "$top": 5000,
                "$skip": 0,
                "$count": "true",
                "$format": "json",
            }

            response = requests.get(url, params=query_params, timeout=120)
            response.raise_for_status()

            data = response.json()

            if "value" not in data:
                self.stdout.write(self.style.ERROR("Invalid OData response format"))
                return

            sites = data["value"]
            self.stdout.write(f"Found {len(sites)} cooling sites")

            processed_count = 0
            skipped_count = 0

            table = get_dynamodb_table()

            with table.batch_writer() as batch:
                for site in sites:
                    try:
                        if not isinstance(site, dict):
                            skipped_count += 1
                            continue

                        # Extract coordinates (X is longitude, Y is latitude)
                        longitude = site.get("x")  # From sample: "x":-73.9597...
                        latitude = site.get("y")  # From sample: "y":40.7359...

                        if not latitude or not longitude:
                            skipped_count += 1
                            continue

                        # Add robust validation for coordinates
                        try:
                            lat_decimal = Decimal(str(latitude))
                            lon_decimal = Decimal(str(longitude))
                        except (ValueError, InvalidOperation):
                            print(f"Invalid coordinates for site: \
                                {site.get('propertyname', 'Unknown')} - \
                                  lat: {latitude}, lon: {longitude}")
                            skipped_count += 1
                            continue

                        # Create a unique AmenityType for each feature_type
                        feature_type_name = str(
                            site.get("featuretype") or "Cooling Site"
                        ).strip()
                        if not feature_type_name:
                            feature_type_name = "Cooling Site"

                        # Create sub-types and link them to the parent
                        amenity_type, created = AmenityType.objects.get_or_create(
                            name=feature_type_name,
                            defaults={
                                "parent": parent_amenity_type,
                                "color": "#1E88E5",  # A cool blue
                                "icon": "snowflake",
                            },
                        )

                        # Use a unique ID from the dataset
                        external_id = site.get(
                            "__id"
                        )  # From sample: "__id":"row-2gks..."
                        if not external_id:
                            skipped_count += 1
                            continue

                        # Combine property and subproperty names
                        prop_name = site.get("propertyname", "")
                        subprop_name = site.get("subpropertyname", "")
                        if subprop_name:
                            prop_name = f"{prop_name}, {subprop_name}"

                        # Determine active status
                        is_active = (
                            str(site.get("status") or "").upper() == "ACTIVATED"
                        )  # From sample: "status":"Activated"

                        # check if in long island format
                        if longitude > 910000:
                            lat, lon = stateplane.to_latlon(
                                longitude, latitude, abbr="NY_LI"
                            )
                            lat_decimal = Decimal(str(lat))
                            lon_decimal = Decimal(str(lon))
                            print(f"{prop_name} converted from Long Island format: \
                                     {lat_decimal}, {lon_decimal}")
                            # continue

                        # print(f"Final coordinates: {lat_decimal}, {lon_decimal}")
                        try:
                            amenity_id = str(external_id)
                            location_hash = geohash2.encode(
                                float(lat_decimal), float(lon_decimal), precision=6
                            )

                            item = {
                                "PK": f"AMENITY#{amenity_id}",
                                "SK": f"AMENITY#{amenity_id}",
                                "GSI1PK": f"GEOHASH#{location_hash}",
                                "GSI1SK": f"TYPE#{feature_type_name}#ACTIVE#{is_active}",  # noqa: E501
                                "Id": amenity_id,
                                "Name": prop_name,
                                "Type": feature_type_name,
                                "Description": f"Type: {feature_type_name}",
                                "Latitude": Decimal(str(lat_decimal)),
                                "Longitude": Decimal(str(lon_decimal)),
                                "Active": is_active,
                                "AverageRating": Decimal("0"),
                                "ReviewCount": 0,
                            }
                            batch.put_item(Item=item)
                            processed_count += 1

                            Amenity.objects.update_or_create(
                                amenity_type=amenity_type,
                                external_id=amenity_id,
                                defaults={
                                    "name": prop_name[:200],
                                    "latitude": float(lat_decimal),
                                    "longitude": float(lon_decimal),
                                    "active": is_active,
                                },
                            )

                            print(f"Added/Updated: {prop_name} (ID: {amenity_id})")
                        except (ValueError, InvalidOperation):
                            print(f"Invalid coordinates for site: \
                                    {site.get('propertyname', 'Unknown')} \
                                        - lat: {latitude}, lon: {longitude}")
                            skipped_count += 1
                            continue

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(
                            self.style.WARNING(f"Skipped entry: {e} - {site}")
                        )
                        skipped_count += 1
                        continue

            self.stdout.write(
                self.style.SUCCESS(
                    f"\nImport complete!\nProcessed (upserted): {processed_count}\n \
                        Skipped: {skipped_count}"
                )
            )

        except requests.exceptions.RequestException as e:
            self.stdout.write(self.style.ERROR(f"Failed to fetch data: {e}"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"An unexpected error occurred: {e}"))
