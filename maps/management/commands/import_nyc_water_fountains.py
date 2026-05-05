import requests
import time
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.conf import settings
from maps.models import AmenityType, Amenity
import boto3
import geohash2

def get_dynamodb_table():
    kwargs = {'region_name': settings.DYNAMODB_REGION}
    if getattr(settings, 'DYNAMODB_ENDPOINT_URL', None):
        kwargs['endpoint_url'] = settings.DYNAMODB_ENDPOINT_URL
    dynamodb = boto3.resource('dynamodb', **kwargs)
    return dynamodb.Table(settings.DYNAMODB_TABLE_NAME)


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

            processed_count = 0
            skipped_count = 0
            table = get_dynamodb_table()

            with table.batch_writer() as batch:
                for fountain in fountains:
                    try:
                        # OData format
                        if not isinstance(fountain, dict):
                            skipped_count += 1
                            continue

                        # Extract basic info
                        propnum = fountain.get("gispropnum", "")
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
                        lat = 0.0
                        lon = 0.0
                        if isinstance(geom, dict) and "coordinates" in geom:
                            lon = geom["coordinates"][0]
                            lat = geom["coordinates"][1]

                        amenity_id = str(external_id)
                        location_hash = geohash2.encode(float(lat), float(lon), precision=6)
                        
                        item = {
                            'PK': f"AMENITY#{amenity_id}",
                            'SK': f"AMENITY#{amenity_id}",
                            'GSI1PK': f"GEOHASH#{location_hash}", 
                            'GSI1SK': f"TYPE#Water Fountain#ACTIVE#{active}", 
                            'Id': amenity_id,
                            'Name': str(name)[:200],
                            'Type': "Water Fountain",
                            'Address': str(prop_name)[:200],
                            'Description': str(position)[:500],
                            'Latitude': Decimal(str(lat)),
                            'Longitude': Decimal(str(lon)),
                            'Active': active,
                            'AverageRating': Decimal('0'),
                            'ReviewCount': 0
                        }
                        batch.put_item(Item=item)
                        processed_count += 1
                        
                        Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=amenity_id,
                            defaults={
                                "name": str(name)[:200],
                                "latitude": float(lat),
                                "longitude": float(lon),
                                "active": active,
                            }
                        )

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(self.style.WARNING(f"Skipped entry: {e}"))
                        skipped_count += 1
                        continue

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
            self.stdout.write(self.style.ERROR(f"Import failed: {e}"))
