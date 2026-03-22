import requests
from decimal import Decimal, InvalidOperation
from django.core.management.base import BaseCommand
from django.db import transaction
from django.contrib.gis.geos import Point
from maps.models import AmenityType, Amenity


class Command(BaseCommand):
    help = (
        "Import LinkNYC kiosks by combining kiosk status and NYC Wi-Fi hotspot datasets"
    )

    STATUS_URL = "https://data.cityofnewyork.us/api/odata/v4/n6c5-95xh"
    WIFI_URL = "https://data.cityofnewyork.us/api/odata/v4/yjub-udmw"

    def _fetch_odata_rows(self, url, top=100000, timeout=120):
        """Fetch OData rows with a high top bound and basic format validation."""
        params = {
            "$top": top,
            "$skip": 0,
            "$count": "true",
            "$format": "json",
        }
        response = requests.get(url, params=params, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("value")
        if not isinstance(rows, list):
            raise ValueError(f"Invalid OData response format from {url}")
        return rows

    def _to_decimal_pair(self, lat_value, lon_value):
        if lat_value in (None, "") or lon_value in (None, ""):
            return None, None
        try:
            lat = Decimal(str(lat_value))
            lon = Decimal(str(lon_value))
            return lat, lon
        except (ValueError, TypeError, InvalidOperation):
            return None, None

    def _coord_key(self, lat_decimal, lon_decimal):
        # 5 decimal places (~1.1m) keeps near-identical points deduped.
        return f"{lat_decimal:.5f}|{lon_decimal:.5f}"

    def _normalize_status_row(self, kiosk):
        if not isinstance(kiosk, dict):
            return None

        latitude = kiosk.get("latitude")
        longitude = kiosk.get("longitude")

        if latitude in (None, "") or longitude in (None, ""):
            geo = kiosk.get("geocoded_column")
            if isinstance(geo, dict):
                coords = geo.get("coordinates")
                if isinstance(coords, list) and len(coords) >= 2:
                    longitude = coords[0]
                    latitude = coords[1]

        lat_decimal, lon_decimal = self._to_decimal_pair(latitude, longitude)
        if lat_decimal is None or lon_decimal is None:
            return None

        site_id = (kiosk.get("site_id") or "").strip()
        address = (kiosk.get("address") or "").strip()
        city = (kiosk.get("city") or "").strip()
        boro = (kiosk.get("boro") or "").strip()
        cross_1 = (kiosk.get("cross_street_1") or "").strip()
        cross_2 = (kiosk.get("cross_street_2") or "").strip()
        corner = (kiosk.get("corner") or "").strip()

        if site_id:
            name = f"LinkNYC {site_id}"
        elif address:
            name = f"LinkNYC - {address.title()}"
        else:
            name = "LinkNYC Kiosk"

        address_components = [
            part for part in [address, city, boro if boro != city else ""] if part
        ]
        full_address = ", ".join(address_components)

        if cross_1 or cross_2:
            cross_parts = [part for part in [cross_1, cross_2] if part]
            cross_desc = " & ".join(cross_parts)
            if corner:
                cross_desc = f"{corner} corner of {cross_desc}"
            if full_address:
                full_address = f"{full_address} ({cross_desc})"
            else:
                full_address = cross_desc

        status = (kiosk.get("status") or "").strip()
        kiosk_type = (kiosk.get("kiosk_type") or "").strip()
        wifi_status = (kiosk.get("wifi_status") or "").strip()
        tablet_status = (kiosk.get("tablet_status") or "").strip()
        phone_status = (kiosk.get("phone_status") or "").strip()

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

        status_lower = status.lower()
        active = status_lower not in {
            "removed",
            "retired",
            "relocated",
            "decommissioned",
        }

        return {
            "canonical_id": site_id.upper() if site_id else "",
            "coord_key": self._coord_key(lat_decimal, lon_decimal),
            "name": name,
            "latitude": lat_decimal,
            "longitude": lon_decimal,
            "address": full_address,
            "prop_name": (kiosk.get("nta") or boro or "").strip(),
            "description": " | ".join(description_parts),
            "active": active,
            "provider": "",
            "source_label": "status",
            "priority": 2,
        }

    def _normalize_wifi_row(self, hotspot):
        if not isinstance(hotspot, dict):
            return None

        provider = (hotspot.get("provider") or "").strip()
        source_id = (hotspot.get("sourceid") or "").strip()
        name = (hotspot.get("name") or "").strip()

        # Keep only LinkNYC rows from the broader hotspot dataset.
        provider_lower = provider.lower()
        is_linknyc = "linknyc" in provider_lower or source_id.upper().startswith(
            "LINK-"
        )
        if not is_linknyc:
            return None

        latitude = hotspot.get("latitude")
        longitude = hotspot.get("longitude")
        if latitude in (None, "") or longitude in (None, ""):
            geo = hotspot.get("location_lat_long")
            if isinstance(geo, dict):
                coords = geo.get("coordinates")
                if isinstance(coords, list) and len(coords) >= 2:
                    longitude = coords[0]
                    latitude = coords[1]

        lat_decimal, lon_decimal = self._to_decimal_pair(latitude, longitude)
        if lat_decimal is None or lon_decimal is None:
            return None

        display_name = (
            f"LinkNYC {source_id}"
            if source_id
            else f"LinkNYC {name}" if name else "LinkNYC Kiosk"
        )
        remarks = (hotspot.get("remarks") or "").strip()
        location_text = (hotspot.get("location") or "").strip()
        city = (hotspot.get("city") or "").strip()
        boroname = (hotspot.get("boroname") or "").strip()
        nta_name = (hotspot.get("ntaname") or "").strip()
        location_type = (hotspot.get("location_t") or "").strip()
        ssid = (hotspot.get("ssid") or "").strip()

        description_parts = []
        if provider:
            description_parts.append(f"Provider: {provider}")
        if location_type:
            description_parts.append(f"Location type: {location_type}")
        if ssid:
            description_parts.append(f"SSID: {ssid}")
        if remarks:
            description_parts.append(f"Remarks: {remarks}")

        address_components = [
            part
            for part in [location_text, city, boroname if boroname != city else ""]
            if part
        ]

        return {
            "canonical_id": source_id.upper() if source_id else "",
            "coord_key": self._coord_key(lat_decimal, lon_decimal),
            "name": display_name,
            "latitude": lat_decimal,
            "longitude": lon_decimal,
            "address": ", ".join(address_components),
            "prop_name": nta_name or boroname,
            "description": " | ".join(description_parts),
            "active": True,
            "provider": provider,
            "source_label": "wifi",
            "priority": 1,
        }

    def _merge_record(self, merged_record, candidate):
        if candidate["priority"] > merged_record["priority"]:
            for key in [
                "name",
                "address",
                "prop_name",
                "description",
                "active",
                "provider",
                "source_label",
                "priority",
            ]:
                merged_record[key] = candidate[key]

        for key in ["name", "address", "prop_name", "description", "provider"]:
            if not merged_record.get(key) and candidate.get(key):
                merged_record[key] = candidate[key]

        if not merged_record.get("canonical_id") and candidate.get("canonical_id"):
            merged_record["canonical_id"] = candidate["canonical_id"]

        merged_record["active"] = bool(
            merged_record.get("active", True) and candidate.get("active", True)
        )

    def _build_external_id(self, record):
        if record.get("canonical_id"):
            return f"linknyc:{record['canonical_id']}"
        return f"linknyc:coord:{record['coord_key']}"

    def handle(self, *args, **options):
        self.stdout.write("Starting LinkNYC kiosks import...")

        amenity_type, created = AmenityType.objects.get_or_create(
            name="LinkNYC Kiosk", defaults={"color": "#4CAF50", "icon": "wifi"}  # Green
        )

        if created:
            self.stdout.write(
                self.style.SUCCESS(f"Created amenity type: {amenity_type.name}")
            )

        try:
            self.stdout.write(f"Fetching status data from: {self.STATUS_URL}")
            status_rows = self._fetch_odata_rows(self.STATUS_URL)
            self.stdout.write(
                f"Found {len(status_rows)} rows in LinkNYC status dataset"
            )

            self.stdout.write(f"Fetching hotspot data from: {self.WIFI_URL}")
            wifi_rows = self._fetch_odata_rows(self.WIFI_URL)
            self.stdout.write(f"Found {len(wifi_rows)} rows in Wi-Fi hotspot dataset")

            merged_by_primary_key = {}
            primary_for_coord = {}
            status_used = 0
            wifi_used = 0
            dedupe_merges = 0

            for row in status_rows:
                record = self._normalize_status_row(row)
                if not record:
                    continue
                key = (
                    f"id:{record['canonical_id']}"
                    if record["canonical_id"]
                    else f"coord:{record['coord_key']}"
                )
                merged_by_primary_key[key] = record
                primary_for_coord[record["coord_key"]] = key
                status_used += 1

            for row in wifi_rows:
                record = self._normalize_wifi_row(row)
                if not record:
                    continue

                key_by_id = (
                    f"id:{record['canonical_id']}" if record["canonical_id"] else ""
                )
                target_key = ""

                if key_by_id and key_by_id in merged_by_primary_key:
                    target_key = key_by_id
                elif record["coord_key"] in primary_for_coord:
                    target_key = primary_for_coord[record["coord_key"]]
                elif key_by_id:
                    target_key = key_by_id
                else:
                    target_key = f"coord:{record['coord_key']}"

                if target_key in merged_by_primary_key:
                    self._merge_record(merged_by_primary_key[target_key], record)
                    dedupe_merges += 1
                else:
                    merged_by_primary_key[target_key] = record

                primary_for_coord[record["coord_key"]] = target_key
                wifi_used += 1

            self.stdout.write(
                f"Prepared {len(merged_by_primary_key)} unique LinkNYC records "
                f"(status used: {status_used}, wifi used: {wifi_used}, \
                    merged duplicates: {dedupe_merges})"
            )

            created_count = 0
            updated_count = 0
            skipped_count = 0

            with transaction.atomic():
                for record in merged_by_primary_key.values():
                    try:
                        lat_decimal = record.get("latitude")
                        lon_decimal = record.get("longitude")
                        if lat_decimal is None or lon_decimal is None:
                            skipped_count += 1
                            continue

                        external_id = self._build_external_id(record)

                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                "name": str(record.get("name") or "LinkNYC Kiosk")[
                                    :200
                                ],
                                "location": Point(
                                    float(lon_decimal), float(lat_decimal), srid=4326
                                ),
                                "address": str(record.get("address") or "")[:300],
                                "prop_name": str(record.get("prop_name") or "")[:200],
                                "description": str(record.get("description") or "")[
                                    :1000
                                ],
                                "operator": str(record.get("provider") or "")[:200],
                                "active": bool(record.get("active", True)),
                            },
                        )

                        if created:
                            created_count += 1
                        else:
                            updated_count += 1

                    except (ValueError, IndexError, TypeError, KeyError) as e:
                        self.stdout.write(
                            self.style.WARNING(f"Skipped entry: {e} - {record}")
                        )
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
        except ValueError as e:
            self.stdout.write(self.style.ERROR(str(e)))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"An unexpected error occurred: {e}"))
