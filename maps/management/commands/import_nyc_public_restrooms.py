import re
import datetime
import requests
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.conf import settings
from maps.models import AmenityType, Amenity
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


# ---------------------------------------------------------------------------
# Hours parsing
# All 146 unique values reduce to 6 structural patterns:
#   P1. Special/terminal: empty, N/A, 24 Hours, Temp Closed, URL, etc.
#   P2. Multi-line: "Monday\t10am-5pm\n..." or "Sunday: Closed\n..."
#   P3. Semicolon-segments: "Mon-Fri: 8am-10pm; Sat & Sun: 9am-10pm"
#   P4. Comma-day-segments: "Friday 4pm-10pm, Saturday 12pm-10pm"
#   P5. Inline day-ranges: "Mon-Fri 7am-12am Sat-Sun 7am-10pm"
#   P6. Single time range: "10:30am-10:30pm"
# ---------------------------------------------------------------------------

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

_DAY_MAP = {
    "monday": "Monday",
    "tuesday": "Tuesday",
    "wednesday": "Wednesday",
    "thursday": "Thursday",
    "friday": "Friday",
    "saturday": "Saturday",
    "sunday": "Sunday",
    "thurs": "Thursday",
    "tues": "Tuesday",
    "wed": "Wednesday",
    "mon": "Monday",
    "tue": "Tuesday",
    "thu": "Thursday",
    "fri": "Friday",
    "sat": "Saturday",
    "sun": "Sunday",
    "th": "Thursday",
    "su": "Sunday",
    "m": "Monday",
    "t": "Tuesday",
    "w": "Wednesday",
    "f": "Friday",
    "s": "Saturday",
    "weekday": "Weekday",
    "weekend": "Weekend",
    "daily": "Daily",
}

# Any single day token (longest alternatives first)
_D = (
    r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    r"|Thurs|Tues|Wed|Mon|Tue|Thu|Fri|Sat|Sun|Th|Su"
    r"|Weekdays?|Weekends?|Daily|Everyday|[MTWFS])"
)

# Like _D but also accepts plural forms: "Sundays", "Mondays"
_DS = (
    r"(?:Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?"
    r"|Thurs|Tues|Wed|Mon|Tue|Thu|Fri|Sat|Sun|Th|Su"
    r"|Weekdays?|Weekends?|Daily|Everyday|[MTWFS])"
)

# Matches a time range like "8am-4pm", "10:30 am - 6:00 pm", "6am - dusk"
_TIME_RE = re.compile(
    r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)"
    r"\s*[-\u2013]\s*"
    r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)|dusk|dawn|midnight|noon)",
    re.IGNORECASE,
)

# Matches "DayRange <sep> time-range" inline
_INLINE_RE = re.compile(
    r"(" + _D + r"(?:-" + _D + r")?)"
    r"[\s]*[-\u2013:]?[\s]+"
    r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?"
    r"\s*[-\u2013]\s*"
    r"(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|dusk|dawn|midnight|noon))",
    re.IGNORECASE,
)

# Matches a segment header like "Monday to Friday:" or "Sat & Sun:" or "Sundays:"
_SEG_RE = re.compile(
    r"^(" + _DS + r"(?:\s*[-\u2013to&and,\s]+\s*" + _DS + r")*)" r"\s*[-:]\s*(.+)$",
    re.IGNORECASE,
)


def _resolve(tok: str):
    """Resolve a day abbreviation to its canonical full name."""
    t = tok.strip().lower()
    return _DAY_MAP.get(t) or _DAY_MAP.get(t.rstrip("s"))


def _range(start: str, end: str):
    s, e = DAYS.index(start), DAYS.index(end)
    return DAYS[s : e + 1] if e >= s else DAYS[s:] + DAYS[: e + 1]


def _expand(token: str):
    """Expand a day expression to a list of full day names."""
    token = token.strip()
    t = token.lower().rstrip("s")
    if t == "weekday":
        return DAYS[:5]
    if t == "weekend":
        return DAYS[5:]
    if t in ("daily", "everyday"):
        return DAYS[:]

    # "Day-Day" or "Day to Day" range
    m = re.match(r"^(.+?)\s*(?:to|-)\s*([A-Za-z]+)$", token, re.IGNORECASE)
    if m:
        d1, d2 = _resolve(m.group(1)), _resolve(m.group(2))
        if d1 and d2:
            if d1 == d2 == "Saturday":  # S-S edge case -> Sat-Sun
                d2 = "Sunday"
            return _range(d1, d2)
        if d1:
            return [d1]

    # "Day & Day" list
    parts = re.split(r"\s*(?:&|and)\s*", token, flags=re.IGNORECASE)
    if len(parts) > 1:
        days = [_resolve(p) for p in parts if _resolve(p)]
        if days:
            return days

    d = _resolve(token)
    return [d] if d else []


def _parse_time(raw: str):
    raw = raw.strip().lower().replace(" ", "").replace(".", "")
    if raw in ("dusk", "dawn"):
        return raw
    if raw in ("midnight", "12am", "12:00am"):
        return "00:00"
    if raw in ("noon", "12pm", "12:00pm"):
        return "12:00"
    for fmt in ("%I:%M%p", "%I%p", "%H:%M"):
        try:
            return datetime.datetime.strptime(raw, fmt).strftime("%H:%M")
        except ValueError:
            pass
    return None


def _time_range(s: str):
    """Return (open_str, close_str) from first time range in s, or None."""
    m = _TIME_RE.search(s)
    if not m:
        return None
    raw_o, raw_c = m.group(1).strip(), m.group(2).strip()
    # Inherit am/pm from close time if open lacks it (e.g. "4:00-10:00pm")
    if not re.search(r"am|pm", raw_o, re.IGNORECASE):
        sf = re.search(r"am|pm", raw_c, re.IGNORECASE)
        if sf:
            raw_o += sf.group(0)
    o, c = _parse_time(raw_o), _parse_time(raw_c)
    return (o, c) if (o and c) else None


def _parse_seg(chunk: str):
    """Parse 'DayGroup: time-range' or 'Day time-range'. Returns (days, tr) or None."""
    chunk = chunk.strip()
    m = _SEG_RE.match(chunk)
    if m:
        days = _expand(m.group(1))
        tr = _time_range(m.group(2))
        if days and tr:
            return days, tr
    # No colon: "Friday 4pm-10pm"
    m2 = re.match(r"^(" + _D + r")\s+(.+)$", chunk, re.IGNORECASE)
    if m2:
        days = _expand(m2.group(1))
        tr = _time_range(m2.group(2))
        if days and tr:
            return days, tr
    return None


def parse_hours(raw: str) -> dict:
    """
    Parse a human-readable hours string into a structured dict.
    Keys: 'Monday'..'Sunday': ["HH:MM","HH:MM"] or None (=closed),
          'default': ["HH:MM","HH:MM"] (no specific day),
          'is_24hrs': True,
          'notes': str
    """
    if not raw or not isinstance(raw, str):
        return {"notes": ""}

    s, sl = raw.strip(), raw.strip().lower()

    # P1: Special / terminal
    if sl in (
        "",
        "empty",
        "n/a",
        "not operational",
        "temp closed",
        "closed",
        "park hours",
        "concession operating hours",
    ):
        return {"notes": s}
    if sl.startswith("http") or "see website" in sl:
        return {"notes": s}
    if "by permit" in sl:
        return {"notes": s}
    if "24 hours" in sl or "24/7" in sl:
        return {"is_24hrs": True}

    # P2: Multi-line (>=2 lines of "DayName: time")
    lines = [ln.strip() for ln in re.split(r"[\n;]", s) if ln.strip()]
    day_line_re = re.compile(
        r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
        r"\s*[:\-\t]\s*(.+)$",
        re.IGNORECASE,
    )
    lm = [day_line_re.match(ln) for ln in lines]
    if sum(1 for m in lm if m) >= 2:
        result, notes = {}, []
        for m, line in zip(lm, lines):
            if not m:
                notes.append(line)
                continue
            day = _resolve(m.group(1))
            tp = re.sub(r"[^\w\s:.\-apmAP]", "-", m.group(2).strip())
            if tp.lower() in ("closed", "close"):
                result[day] = None
            else:
                tr = _time_range(tp)
                result[day] = list(tr) if tr else None
                if not tr:
                    notes.append(f"{day}: {tp}")
        if notes:
            result["notes"] = ". ".join(notes)
        return result

    flat = re.sub(r"[\t\n]+", " ", s).strip()

    # P2b: "Everyday ..." or "... Daily"
    m = re.match(r"^(?:every\s*day|daily)\s+(.+)$", flat, re.IGNORECASE)
    if not m:
        m = re.match(r"^(.+?)\s+(?:daily|every\s*day)$", flat, re.IGNORECASE)
    if m:
        tp, *extra = re.split(r",(?=\s*[A-Za-z])", m.group(1), 1)
        tr = _time_range(tp)
        if tr:
            result = {d: list(tr) for d in DAYS}
            if extra:
                result["notes"] = extra[0].strip()
            return result

    # Pre-process: "DayToken-DayToken-digit" -> insert space before digit
    # Fixes "Mon-Thurs-4:00pm-10pm" -> "Mon-Thurs 4:00pm-10pm"
    flat = re.sub(
        r"(" + _D + r")-(" + _D + r")-(\d)", r"\1-\2 \3", flat, flags=re.IGNORECASE
    )

    # P3: Semicolon-separated segments
    semi = [c.strip() for c in flat.split(";") if c.strip()]
    if len(semi) > 1:
        result, notes, hit = {}, [], 0
        for chunk in semi:
            parsed = _parse_seg(chunk)
            if parsed:
                hit += 1
                for d in parsed[0]:
                    result[d] = list(parsed[1])
            else:
                notes.append(chunk)
        if hit:
            if notes:
                result["notes"] = ". ".join(notes)
            return result

    # P4: Comma-separated day segments
    comma_chunks = re.split(r",\s*(?=" + _D + r"\b)", flat, flags=re.IGNORECASE)
    if len(comma_chunks) > 1:
        result, notes, hit = {}, [], 0
        for chunk in comma_chunks:
            parsed = _parse_seg(chunk.strip())
            if parsed:
                hit += 1
                for d in parsed[0]:
                    result[d] = list(parsed[1])
            else:
                notes.append(chunk.strip())
        if hit:
            if notes:
                result["notes"] = ". ".join(notes)
            return result

    # P5: Inline "DayRange time-range DayRange time-range ..."
    matches = list(_INLINE_RE.finditer(flat))
    if matches:
        result = {}
        for m in matches:
            days = _expand(m.group(1))
            tr = _time_range(m.group(2))
            for d in days:
                if tr:
                    result[d] = list(tr)
        if result:
            return result

    # P6: Single time range fallback
    main, *rest = re.split(r",(?=\s*[A-Za-z])", flat, 1)
    main = re.sub(r"^[^0-9]*(from\s+)?", "", main, flags=re.IGNORECASE)
    tr = _time_range(main)
    if tr:
        result = {"default": list(tr)}
        if rest:
            result["notes"] = rest[0].strip()
        return result

    return {"notes": s}


# ---------------------------------------------------------------------------
# Populate per-day model fields from parsed hours
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Management command
# ---------------------------------------------------------------------------


class Command(BaseCommand):
    help = "Import NYC public restrooms from NYC Open Data"

    def handle(self, *args, **options):
        self.stdout.write("Starting NYC public restrooms import...")

        amenity_type, created = AmenityType.objects.get_or_create(
            name="Restroom",
            defaults={"color": "#9C27B0", "icon": "restroom"},
        )
        if created:
            self.stdout.write(
                self.style.SUCCESS(f"Created amenity type: {amenity_type.name}")
            )

        url = "https://data.cityofnewyork.us/api/odata/v4/i7jb-7jku"

        try:
            self.stdout.write(f"Fetching data from: {url}")
            response = requests.get(
                url,
                params={"$top": 10000, "$skip": 0, "$count": "true"},
                timeout=60,
            )
            response.raise_for_status()
            data = response.json()

            if "value" not in data:
                self.stdout.write(self.style.ERROR("Invalid OData response format"))
                return

            restrooms = data["value"]
            self.stdout.write(f"Found {len(restrooms)} restrooms")

            processed_count = 0
            skipped_count = 0
            table = get_dynamodb_table()

            for restroom in restrooms:
                try:
                    if not isinstance(restroom, dict):
                        skipped_count += 1
                        continue

                    geom = restroom.get("location_1")
                    if not geom:
                        skipped_count += 1
                        continue

                    external_id = restroom.get("__id") or (
                        f"restroom_"
                        f"{geom['coordinates'][1]}_"
                        f"{geom['coordinates'][0]}"
                    )
                    name = restroom.get("facility_name") or "Public Restroom"

                    description_parts = [
                        p
                        for p in [
                            (
                                f"Type: {restroom.get('restroom_type')}"
                                if restroom.get("restroom_type")
                                else ""
                            ),
                            restroom.get("location_type") or "",
                            restroom.get("additional_notes") or "",
                        ]
                        if p
                    ]
                    description = " | ".join(description_parts)

                    operator = restroom.get("operator") or ""

                    raw_hours = restroom.get("hours_of_operation") or ""
                    hours_dict = parse_hours(raw_hours)

                    seasonal = (
                        str(restroom.get("open_year_round", "")).strip().lower()
                        == "seasonal"
                    )

                    cs_raw = str(restroom.get("changing_stations", "")).strip().lower()
                    changing_stations = cs_raw.startswith("yes")

                    accessibility = ""
                    acc = str(restroom.get("accessibility", "")).strip().lower()
                    if "fully" in acc:
                        accessibility = "Fully Accessible"
                    elif "partial" in acc:
                        accessibility = "Partially Accessible"
                    elif "limited" in acc:
                        accessibility = "Limited Accessibility"
                    elif "not" in acc or acc == "no":
                        accessibility = "Not Accessible"

                    active = (
                        str(restroom.get("status", "")).strip().lower() == "operational"
                    )

                    lat = float(geom["coordinates"][1])
                    lon = float(geom["coordinates"][0])
                    amenity_id = str(external_id)
                    location_hash = geohash2.encode(lat, lon, precision=6)

                    item = {
                        "PK": f"AMENITY#{amenity_id}",
                        "SK": f"AMENITY#{amenity_id}",
                        "GSI1PK": f"GEOHASH#{location_hash}",
                        "GSI1SK": f"TYPE#Restroom#ACTIVE#{active}",
                        "Id": amenity_id,
                        "Name": str(name)[:200],
                        "Type": "Restroom",
                        "Description": str(description)[:1000],
                        "Operator": str(operator)[:200],
                        "HoursOfOperation": hours_dict,
                        "ChangingStations": changing_stations,
                        "Accessibility": accessibility,
                        "Seasonal": seasonal,
                        "Latitude": Decimal(str(lat)),
                        "Longitude": Decimal(str(lon)),
                        "Active": active,
                        "AverageRating": Decimal("0"),
                        "ReviewCount": 0,
                    }
                    table.put_item(Item=item)
                    processed_count += 1

                    Amenity.objects.update_or_create(
                        amenity_type=amenity_type,
                        external_id=amenity_id,
                        defaults={
                            "name": str(name)[:200],
                            "latitude": float(lat),
                            "longitude": float(lon),
                            "active": active,
                        },
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
            self.stdout.write(self.style.ERROR(f"Unexpected error: {e}"))
            raise
