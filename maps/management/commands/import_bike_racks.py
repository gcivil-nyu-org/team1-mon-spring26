import requests
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction
from maps.models import AmenityType, Amenity


class Command(BaseCommand):
    help = 'Import NYC bike racks from NYC Open Data'

    def handle(self, *args, **options):
        self.stdout.write('Starting NYC bike racks import...')

        # Create or get the Bike Rack amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name='Bike Rack',
            defaults={
                'color': '#FF9800',  # Orange
                'icon': 'bicycle'
            }
        )

        if created:
            self.stdout.write(self.style.SUCCESS(f'Created amenity type: {amenity_type.name}'))

        # NYC Open Data OData v4 endpoint for bike racks
        url = 'https://data.cityofnewyork.us/api/odata/v4/592z-n7dk'

        try:
            self.stdout.write(f'Fetching data from: {url}')

            query_params = {
                '$top': 100000,  # A large number to get all racks
                '$skip': 0,
                '$count': 'true'
            }

            response = requests.get(url, params=query_params, timeout=120)
            response.raise_for_status()

            data = response.json()

            if 'value' not in data:
                self.stdout.write(self.style.ERROR('Invalid OData response format'))
                return

            racks = data['value']
            self.stdout.write(f'Found {len(racks)} bike racks')

            created_count = 0
            updated_count = 0
            skipped_count = 0

            with transaction.atomic():
                for rack in racks:
                    try:
                        if not isinstance(rack, dict):
                            skipped_count += 1
                            continue

                        # Extract coordinates
                        latitude = rack.get('latitude')
                        longitude = rack.get('longitude')

                        if not latitude or not longitude:
                            skipped_count += 1
                            continue
                        
                        # Add robust validation for coordinates
                        try:
                            lat_decimal = Decimal(str(latitude))
                            lon_decimal = Decimal(str(longitude))
                        except (ValueError, Decimal.InvalidOperation):
                            skipped_count += 1
                            continue

                        # Use a unique ID from the dataset if available, otherwise generate one
                        external_id = rack.get('site_id') or f"bikerack_{latitude}_{longitude}"

                        # Map fields to the Amenity model
                        ifo_address = rack.get('ifoaddress', '')  # Capture the physical address
                        # Use the address as a fallback for the name if 'ntaname' is missing or empty.
                        name = rack.get('ntaname') or ifo_address or 'Bike Rack'
                        rack_type_desc = rack.get('racktype', 'Standard Rack')

                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                'name': name,
                                'address': ifo_address,
                                'latitude': lat_decimal,
                                'longitude': lon_decimal,
                                'description': f"Type: {rack_type_desc}",
                                'active': True,  # Assume all imported racks are active
                            }
                        )

                        if created:
                            created_count += 1
                        else:
                            updated_count += 1

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(self.style.WARNING(f'Skipped entry: {e} - {rack}'))
                        skipped_count += 1
                        continue

            self.stdout.write(self.style.SUCCESS(
                f'\nImport complete!\n'
                f'Created: {created_count}\n'
                f'Updated: {updated_count}\n'
                f'Skipped: {skipped_count}'
            ))

        except requests.exceptions.RequestException as e:
            self.stdout.write(self.style.ERROR(f'Failed to fetch data: {e}'))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'An unexpected error occurred: {e}'))