import requests
from decimal import Decimal, InvalidOperation
from django.core.management.base import BaseCommand
from django.db import transaction
from maps.models import AmenityType, Amenity


class Command(BaseCommand):
    help = 'Import LinkNYC kiosks from NYC Open Data'

    def handle(self, *args, **options):
        self.stdout.write('Starting LinkNYC kiosks import...')

        # Create or get the LinkNYC Kiosk amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name='LinkNYC Kiosk',
            defaults={
                'color': '#4CAF50',  # Green
                'icon': 'wifi'
            }
        )

        if created:
            self.stdout.write(self.style.SUCCESS(f'Created amenity type: {amenity_type.name}'))

        # NYC Open Data OData v4 endpoint for LinkNYC Kiosk Status
        # Dataset: https://data.cityofnewyork.us/City-Government/LinkNYC-Kiosk-Status/n6c5-95xh
        url = 'https://data.cityofnewyork.us/api/odata/v4/n6c5-95xh'

        try:
            self.stdout.write(f'Fetching data from: {url}')

            query_params = {
                '$top': 100000,      # Large upper bound to fetch all kiosks
                '$skip': 0,
                '$count': 'true',
                '$format': 'json',   # Ensure JSON instead of XML
            }

            response = requests.get(url, params=query_params, timeout=120)
            response.raise_for_status()

            data = response.json()

            if 'value' not in data:
                self.stdout.write(self.style.ERROR('Invalid OData response format'))
                return

            kiosks = data['value']
            self.stdout.write(f'Found {len(kiosks)} LinkNYC kiosks')

            created_count = 0
            updated_count = 0
            skipped_count = 0

            with transaction.atomic():
                for kiosk in kiosks:
                    try:
                        if not isinstance(kiosk, dict):
                            skipped_count += 1
                            continue

                        # Coordinates: primary from latitude/longitude, fallback to geocoded_column
                        latitude = kiosk.get('latitude')
                        longitude = kiosk.get('longitude')

                        if not latitude or not longitude:
                            geo = kiosk.get('geocoded_column')
                            if isinstance(geo, dict) and 'coordinates' in geo:
                                coords = geo['coordinates']
                                if len(coords) >= 2:
                                    longitude = coords[0]
                                    latitude = coords[1]

                        if not latitude or not longitude:
                            skipped_count += 1
                            continue

                        try:
                            lat_decimal = Decimal(str(latitude))
                            lon_decimal = Decimal(str(longitude))
                        except (ValueError, TypeError, InvalidOperation):
                            skipped_count += 1
                            continue

                        # Unique identifier for the kiosk
                        site_id = kiosk.get('site_id')
                        external_id = site_id or kiosk.get('__id') or f"linknyc_{lat_decimal}_{lon_decimal}"

                        # Human-readable name
                        address = kiosk.get('address') or ''
                        city = kiosk.get('city') or ''
                        boro = kiosk.get('boro') or ''

                        if site_id:
                            name = f"LinkNYC {site_id}"
                        elif address:
                            name = f"LinkNYC - {address.title()}"
                        else:
                            name = 'LinkNYC Kiosk'

                        # Build address string (include cross streets when available)
                        cross_1 = kiosk.get('cross_street_1') or ''
                        cross_2 = kiosk.get('cross_street_2') or ''
                        corner = kiosk.get('corner') or ''

                        components = [address]
                        if city:
                            components.append(city)
                        if boro and boro != city:
                            components.append(boro)

                        full_address = ', '.join([c for c in components if c])

                        if cross_1 or cross_2:
                            cross_parts = [p for p in [cross_1, cross_2] if p]
                            if corner:
                                cross_desc = f"{corner} corner of " + ' & '.join(cross_parts)
                            else:
                                cross_desc = ' & '.join(cross_parts)
                            if full_address:
                                full_address = f"{full_address} ({cross_desc})"
                            else:
                                full_address = cross_desc

                        # Use neighborhood / NTA as property name (if available)
                        prop_name = kiosk.get('nta') or kiosk.get('boro') or ''

                        # Status fields for description
                        status = kiosk.get('status') or ''
                        kiosk_type = kiosk.get('kiosk_type') or ''
                        wifi_status = kiosk.get('wifi_status') or ''
                        tablet_status = kiosk.get('tablet_status') or ''
                        phone_status = kiosk.get('phone_status') or ''

                        description_parts = []
                        if kiosk_type:
                            description_parts.append(f"Type: {kiosk_type}")
                        if status:
                            description_parts.append(f"Kiosk status: {status}")
                        if wifi_status:
                            description_parts.append(f"WiFi: {wifi_status}")
                        if tablet_status:
                            description_parts.append(f"Tablet: {tablet_status}")
                        if phone_status:
                            description_parts.append(f"Phone: {phone_status}")

                        description = ' | '.join(description_parts)

                        # Treat kiosks as active unless clearly removed/retired
                        status_lower = str(status).strip().lower()
                        active = status_lower not in ['removed', 'retired', 'relocated', 'decommissioned']

                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                'name': str(name)[:200],
                                'latitude': lat_decimal,
                                'longitude': lon_decimal,
                                'address': full_address[:300],
                                'prop_name': str(prop_name)[:200],
                                'description': description[:1000],
                                'active': active,
                            }
                        )

                        if created:
                            created_count += 1
                        else:
                            updated_count += 1

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(self.style.WARNING(f'Skipped entry: {e} - {kiosk}'))
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

