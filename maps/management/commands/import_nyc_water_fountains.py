import requests
import time
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction
from maps.models import AmenityType, Amenity


class Command(BaseCommand):
    help = 'Import NYC water fountains from NYC Open Data'

    def handle(self, *args, **options):
        self.stdout.write('Starting NYC water fountains import...')
        
        # Create or get the Water Fountain amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name='Water Fountain',
            defaults={
                'color': '#00BCD4',
                'icon': 'droplet'
            }
        )
        
        if created:
            self.stdout.write(self.style.SUCCESS(f'Created amenity type: {amenity_type.name}'))
        
        # NYC Open Data OData v4 endpoint
        url = 'https://data.cityofnewyork.us/api/odata/v4/qnv7-p7a2'
        
        try:
            self.stdout.write(f'Fetching data from: {url}')

            # Define your query parameters
            query_params = {
                '$top': 10000,      # Limit to 10k rows
                '$skip': 0,         # Start at the beginning
                '$count': 'true'    # Get total record count
            }

            response = requests.get(url, params=query_params, timeout=60)
            response.raise_for_status()
            
            data = response.json()
            
            # OData v4 format has results in 'value' key
            if 'value' not in data:
                self.stdout.write(self.style.ERROR('Invalid OData response format'))
                return
            
            fountains = data['value']
            self.stdout.write(f'Found {len(fountains)} water fountains')
            
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
                        external_id = fountain.get('system') or fountain.get('_id') or fountain.get('ID') or f"{fountain.get('gispropnum', '')}_{int(time.time() * 1000)}"
                        name = fountain.get('Location') or fountain.get('location') or 'Water Fountain'
                        position = fountain.get('Position') or fountain.get('position') or ''
                        prop_name = fountain.get('propertyna') or fountain.get('PropName') or fountain.get('propName') or fountain.get('prop_name') or ''
                        
                        # Check active status
                        active = True
                        if 'Active' in fountain:
                            active_str = str(fountain['Active']).lower()
                            active = active_str in ['true', 'yes', '1', 'y', 'active']
                        
                        # Parse coordinates
                        latitude = None
                        longitude = None
                        
                        # Try different coordinate field names
                        if 'Latitude' in fountain and 'Longitude' in fountain:
                            latitude = Decimal(str(fountain['Latitude']))
                            longitude = Decimal(str(fountain['Longitude']))
                        elif 'latitude' in fountain and 'longitude' in fountain:
                            latitude = Decimal(str(fountain['latitude']))
                            longitude = Decimal(str(fountain['longitude']))
                        elif 'Lat' in fountain and 'Lon' in fountain:
                            latitude = Decimal(str(fountain['Lat']))
                            longitude = Decimal(str(fountain['Lon']))
                        elif 'lat' in fountain and 'lon' in fountain:
                            latitude = Decimal(str(fountain['lat']))
                            longitude = Decimal(str(fountain['lon']))
                        elif 'the_geom' in fountain:
                            # Handle GeoJSON geometry
                            geom = fountain['the_geom']
                            if isinstance(geom, dict):
                                if 'coordinates' in geom:
                                    coords = geom['coordinates']
                                    if len(coords) >= 2:
                                        longitude = Decimal(str(coords[0]))
                                        latitude = Decimal(str(coords[1]))
                        
                        # Skip if coordinates are missing or zero
                        if not latitude or not longitude or latitude == 0 or longitude == 0:
                            skipped_count += 1
                            continue
                        
                        # Create or update using composite key (amenity_type, external_id)
                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                'name': str(name)[:200],
                                'latitude': latitude,
                                'longitude': longitude,
                                'description': str(position)[:500],
                                'prop_name': str(prop_name)[:200],
                                'active': active,
                            }
                        )
                        
                        if created:
                            created_count += 1
                        else:
                            updated_count += 1
                    
                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(self.style.WARNING(f'Skipped entry: {e}'))
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
            self.stdout.write(self.style.ERROR(f'Import failed: {e}'))

