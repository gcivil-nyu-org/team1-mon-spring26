import requests
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction
from mapdata.models import AmenityType, Amenity


class Command(BaseCommand):
    help = 'Import NYC water fountains from NYC Open Data'

    def handle(self, *args, **options):
        amenity_type, _ = AmenityType.objects.get_or_create(
            name='Water Fountain',
            defaults={'color': '#00BCD4', 'icon': 'droplet'}
        )

        url = 'https://data.cityofnewyork.us/api/odata/v4/qnv7-p7a2'
        response = requests.get(url, params={'$top': 10000, '$skip': 0}, timeout=60)
        response.raise_for_status()
        fountains = response.json().get('value', [])
        self.stdout.write(f'Found {len(fountains)} fountains')

        created, updated, skipped = 0, 0, 0

        with transaction.atomic():
            for f in fountains:
                try:
                    lat = lon = None
                    for lat_key, lon_key in [('Latitude','Longitude'), ('latitude','longitude'), ('Lat','Lon')]:
                        if lat_key in f and lon_key in f:
                            lat = Decimal(str(f[lat_key]))
                            lon = Decimal(str(f[lon_key]))
                            break
                    if not lat or not lon:
                        geom = f.get('the_geom', {})
                        if isinstance(geom, dict) and 'coordinates' in geom:
                            lon, lat = Decimal(str(geom['coordinates'][0])), Decimal(str(geom['coordinates'][1]))

                    if not lat or not lon:
                        skipped += 1
                        continue

                    external_id = str(f.get('system') or f.get('_id') or f'{lat}_{lon}')
                    _, was_created = Amenity.objects.update_or_create(
                        amenity_type=amenity_type,
                        external_id=external_id,
                        defaults={
                            'name': str(f.get('Location') or 'Water Fountain')[:200],
                            'latitude': lat,
                            'longitude': lon,
                            'position': str(f.get('Position', ''))[:500],
                            'prop_name': str(f.get('propertyna', ''))[:200],
                            'active': str(f.get('Active', 'true')).lower() in ['true', 'yes', '1'],
                        }
                    )
                    if was_created:
                        created += 1
                    else:
                        updated += 1
                except Exception as e:
                    self.stdout.write(self.style.WARNING(f'Skipped: {e}'))
                    skipped += 1

        self.stdout.write(self.style.SUCCESS(f'Done. Created: {created}, Updated: {updated}, Skipped: {skipped}'))