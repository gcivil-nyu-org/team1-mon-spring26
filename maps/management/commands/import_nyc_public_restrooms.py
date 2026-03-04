import requests
from dateparser import parse as dateparse
import re
from django.core.management.base import BaseCommand
from django.db import transaction
from django.contrib.gis.geos import GEOSGeometry
from maps.models import AmenityType, Amenity
import json


def _parse_time(time_string):
    """
    Parses a single time string (e.g., "8am", "9:00 pm", "dusk") into HH:MM format.
    """
    if not time_string:
        return None
    # Handle special, non-time strings
    if time_string.lower() in ["dusk", "dawn"]:
        return time_string.capitalize()
    try:
        # The dateparser library is good at guessing formats
        dt = dateparse(time_string)
        if dt:
            return dt.strftime("%H:%M")
    except (ValueError, TypeError):
        return None
    return None


def parse_hours(hours_string):
    """
    Parses a human-readable hours string into dict w/24-hour times.
    """
    if (
        not hours_string
        or not isinstance(hours_string, str)
        or hours_string.strip().lower() in ["n/a", "not operational", "temp closed"]
    ):
        return {"default": ["00:00", "24:00"], "notes": "Assumed to be open 24/7"}

    hours_string = hours_string.strip()
    if "24 hours" in hours_string.lower() or "24/7" in hours_string:
        return {"default": ["00:00", "24:00"]}

    hours_dict = {}
    notes = []

    # Handle cases like "Open by permit" or URLs
    if (
        "by permit" in hours_string.lower()
        or hours_string.lower().startswith("http")
        or "see website" in hours_string.lower()
    ):
        notes.append(hours_string)
        return {"notes": ". ".join(notes)}

    # --- Main Parsing Logic ---
    # This regex is designed to find blocks of day(s) followed by their times.
    # It handles single days, day ranges, and keywords like "Weekdays".
    day_time_regex = re.compile(
        r"\b(Mon|Tues|Wed|Thurs|Fri|Sat|Sun|Weekdays|Weekends|Daily)s?\b"  # Day(s)
        r"(?:\s*(-|–|to)\s*\b(Mon|Tues|Wed|Thurs|Fri|Sat|Sun)\b)?"  # Optional day range
        r"\s*[:\-]?\s*"  # Separator
        r"([\w\s:./\-,&]+?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|dusk|closed|dawn))",
        # ^Time string
        re.IGNORECASE,
    )

    # Regex to find day ranges or single days, including single-letter abbreviations
    day_time_regex = re.compile(
        r"\b(M|T|W|Th|F|S|Su|Mon|Tues|Wed|Thurs|Fri|Sat|Sun|Weekdays|Weekends|Daily)s?\b"  # noqa: E501 line too long
        # ^Day(s)
        r"(?:\s*(-|–|to)\s*\b(M|T|W|Th|F|S|Su|Mon|Tues|Wed|Thurs|Fri|Sat|Sun)\b)?"
        # ^Optional day range
        r"\s*[:\-]?\s*"
        r"((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|dusk|closed|dawn)(?:\s*(-|–|to)\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|dusk|dawn))?)",  # noqa: E501 line too long
        re.IGNORECASE,
    )

    day_map_full = {
        "M": "Monday",
        "T": "Tuesday",
        "W": "Wednesday",
        "Th": "Thursday",
        "F": "Friday",
        "S": "Saturday",
        "Su": "Sunday",
        "Mon": "Monday",
        "Tues": "Tuesday",
        "Wed": "Wednesday",
        "Thurs": "Thursday",
        "Fri": "Friday",
        "Sat": "Saturday",
        "Sun": "Sunday",
    }
    day_order = ["M", "T", "W", "Th", "F", "S", "Su"]
    all_week_days = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ]

    # Handle multi-line formats first (like for libraries)
    lines = [line.strip() for line in hours_string.split("\n") if line.strip()]
    processed_string = " ".join(lines)

    # --- Logic for single-line formats (inc. "M-T ... W-S ...") ---
    matches = list(day_time_regex.finditer(processed_string))
    unparsed_parts = []

    if matches:
        last_end = 0
        for match in matches:
            if match.start() > last_end:
                unparsed_parts.append(
                    processed_string[last_end : match.start()].strip(",. ")
                )
            last_end = match.end()

            start_day_abbr, _, end_day_abbr, time_str, _ = match.groups()
            time_str = time_str.strip()

            # Normalize day abbreviations (M -> Mon, T -> Tues, etc.)
            start_day_key = start_day_abbr.capitalize()
            end_day_key = end_day_abbr.capitalize() if end_day_abbr else None

            days_to_process = []
            start_day_lower = start_day_abbr.lower()

            if start_day_lower == "weekdays":
                days_to_process = all_week_days[:5]
            elif start_day_lower == "weekends":
                days_to_process = all_week_days[5:]
            elif start_day_lower == "daily":
                days_to_process = all_week_days
            elif end_day_key:
                # Handle ranges like M-T
                try:
                    # Use a consistent order for single-letter abbreviations
                    start_idx = day_order.index(start_day_key)
                    # Special case for 'S-S' meaning Saturday-Sunday
                    if start_day_key == "S" and end_day_key == "S":
                        end_day_key = "Su"
                    end_idx = day_order.index(end_day_key)
                    # ranges that wrap around, e.g., S-Su (Sat-Sun) or F-M (Fri-Mon)
                    if end_idx < start_idx:
                        selected_days = day_order[start_idx:] + day_order[: end_idx + 1]
                    else:
                        selected_days = day_order[start_idx : end_idx + 1]
                    days_to_process = [day_map_full[d] for d in selected_days]
                except (ValueError, KeyError):
                    unparsed_parts.append(match.group(0))
                    continue
            else:
                if start_day_key.capitalize() in day_map_full:
                    days_to_process = [day_map_full[start_day_key.capitalize()]]
                else:
                    unparsed_parts.append(match.group(0))
                    continue

            # Parse the time string for this block
            if "closed" in time_str.lower():
                parsed_time = None
            else:
                # Clean up time string by removing extra dots
                cleaned_time_str = time_str.replace(".", "")
                time_matches = re.findall(
                    r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|dusk|dawn)",
                    cleaned_time_str,
                    re.IGNORECASE,
                )
                if len(time_matches) >= 2:
                    open_time, close_time = _parse_time(time_matches[0]), _parse_time(
                        time_matches[1]
                    )
                    if open_time and close_time:
                        parsed_time = [open_time, close_time]
                    else:  # Handle dusk/dawn
                        parsed_time = [time_matches[0], time_matches[1]]
                else:
                    parsed_time = None
                    unparsed_parts.append(match.group(0))

            if parsed_time is not None:
                for day in days_to_process:
                    hours_dict[day] = parsed_time

        if last_end < len(processed_string):
            unparsed_parts.append(processed_string[last_end:].strip(",. "))

    else:
        # Fallback for simple formats like "8am-4pm, Open later seasonally"
        main_part, *note_parts = re.split(r",(?=\s*[A-Z])", processed_string, 1)
        notes.extend(note_parts)
        time_matches = re.findall(
            r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|dusk|dawn)", main_part, re.IGNORECASE
        )
        if len(time_matches) == 2:
            open_time, close_time = _parse_time(time_matches[0]), _parse_time(
                time_matches[1]
            )
            if open_time and close_time:
                hours_dict["default"] = [open_time, close_time]
        else:
            unparsed_parts.append(processed_string)

    # Consolidate all notes
    all_notes = notes + [part for part in unparsed_parts if part]
    if all_notes:
        hours_dict["notes"] = ". ".join(all_notes)

    if not hours_dict and not all_notes:
        return {"notes": hours_string}

    return hours_dict


class Command(BaseCommand):
    help = "Import NYC public restrooms from NYC Open Data"

    def handle(self, *args, **options):
        self.stdout.write("Starting NYC public restrooms import...")

        # Create or get the Public Restroom amenity type
        amenity_type, created = AmenityType.objects.get_or_create(
            name="Restroom", defaults={"color": "#9C27B0", "icon": "restroom"}
        )

        if created:
            self.stdout.write(
                self.style.SUCCESS(f"Created amenity type: {amenity_type.name}")
            )

        # NYC Open Data OData v4 endpoint for public restrooms
        url = "https://data.cityofnewyork.us/api/odata/v4/i7jb-7jku"

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

            restrooms = data["value"]
            self.stdout.write(f"Found {len(restrooms)} public restrooms")

            # Debug: Show sample of available fields
            if restrooms:
                self.stdout.write(f"Sample record fields: {list(restrooms[0].keys())}")
                first_record = restrooms[0]
                self.stdout.write(f'Sample ID fields: id={first_record.get("__id")}, \
                          _id={first_record.get("__id")}, \
                          location_zip={first_record.get("location_zip")}')

            created_count = 0
            updated_count = 0
            skipped_count = 0

            with transaction.atomic():
                for restroom in restrooms:
                    try:
                        # OData format
                        if not isinstance(restroom, dict):
                            skipped_count += 1
                            continue

                        # use location_1 (GeoJSON Point)
                        geom = restroom.get("location_1")

                        # Now extract ID - use the __id field (double underscore)
                        external_id = (
                            restroom.get("__id")
                            or f"restroom_{geom.coordinates[1]}_{geom.coordinates[0]}"
                        )

                        # Location name - use facility_name
                        name = restroom.get("facility_name") or "Public Restroom"

                        # Location type (additional description)
                        location_type = (
                            restroom.get("location_type") or restroom.get("Type") or ""
                        )

                        # Restroom type (e.g., single stall, multiple stalls)
                        restroom_type = (
                            restroom.get("restroom_type")
                            or restroom.get("Restroom_Type")
                            or ""
                        )

                        # Additional notes
                        additional_notes = (
                            restroom.get("additional_notes")
                            or restroom.get("Additional_Notes")
                            or ""
                        )

                        # Build description from available text fields
                        description_parts = []
                        if restroom_type:
                            description_parts.append(f"Type: {restroom_type}")
                        if location_type:
                            description_parts.append(location_type)
                        if additional_notes:
                            description_parts.append(additional_notes)
                        description = " | ".join(description_parts)

                        # Operator/owner info
                        operator = (
                            restroom.get("operator") or restroom.get("Operator") or ""
                        )

                        # Hours of operation
                        raw_hours = (
                            restroom.get("hours_of_operation")
                            or restroom.get("Hours_of_Operation")
                            or ""
                        )
                        hours_of_operation = parse_hours(raw_hours) or {}

                        # Seasonal status
                        seasonal = (
                            str(restroom.get("open_year_round", "")).strip().lower()
                            == "seasonal"
                        )

                        # Changing stations
                        changing_stations = False
                        if "changing_stations" in restroom:
                            cs_str = str(restroom.get("changing_stations", "")).lower()
                            changing_stations = cs_str in [
                                "true",
                                "yes",
                                "1",
                                "y",
                                "available",
                            ]

                        # Accessibility (ADA accessible) - capture the actual text value
                        accessibility = ""
                        if "accessibility" in restroom:
                            acc_value = str(restroom.get("accessibility", "")).strip()
                            # Normalize the value
                            if "fully" in acc_value.lower():
                                accessibility = "Fully Accessible"
                            elif "partial" in acc_value.lower():
                                accessibility = "Partially Accessible"
                            elif (
                                "not" in acc_value.lower() or "no" in acc_value.lower()
                            ):
                                accessibility = "Not Accessible"
                            elif acc_value and acc_value.lower() not in ["", "unknown"]:
                                # Preserve other values as-is if they're meaningful
                                accessibility = acc_value[:50]

                        # Check available status using 'status' field
                        status_str = str(restroom.get("status", "")).strip().lower()
                        active = status_str == "operational"

                        obj, created = Amenity.objects.update_or_create(
                            amenity_type=amenity_type,
                            external_id=str(external_id),
                            defaults={
                                "name": str(name)[:200],
                                "location": GEOSGeometry(json.dumps(geom)),
                                "description": str(description)[:1000],
                                "operator": str(operator)[:200],
                                "hours_of_operation": hours_of_operation,
                                "changing_stations": changing_stations,
                                "accessibility": accessibility,
                                "seasonal": seasonal,
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
            self.stdout.write(self.style.ERROR(f"An unexpected error occurred: {e}"))
