# NYC Water Fountains Map App - Setup Guide

## Quick Start

### 1. Install Dependencies
```bash
pip install requests
```

### 2. Run Migrations
```bash
python manage.py makemigrations maps  # Optional - creates migration from current models
python manage.py migrate maps
```

### 3. Create Superuser (optional, for admin access)
```bash
python manage.py createsuperuser
```

### 4. Import NYC Water Fountains Data
```bash
python manage.py import_nyc_water_fountains
```

This will download and import water fountains from NYC's official OpenData portal. The import handles:
- GPS coordinates (latitude/longitude)
- Active/Inactive status
- Position descriptions (location text)
- Automatic deduplication using external_id

### 5. Run Development Server
```bash
python manage.py runserver
```

Visit `http://localhost:8000/` in your browser.

## Features

### Frontend Map
- **Geolocation**: Automatically detects user location on page load
- **Search**: Autocomplete search for addresses and locations using OpenStreetMap Nominatim
- **Location Pin**: Blue pin at user location, orange pin at searched location
- **Location Button**: Click the 📍 button in lower right to retry geolocation
- **Amenity Filters**: Click amenity types to filter on map
- **Active Filter**: Toggle "Show inactive amenities" to display closed/off-service fountains
- **Dynamic Loading**: Map queries amenities in the visible area when you pan/zoom

### Backend APIs
- `GET /`: Main map view
- `GET /api/amenities/`: Get amenities with optional filters
  - Query parameters:
    - `north`, `south`, `east`, `west`: Bounding box for map area
    - `type_id`: Filter by amenity type
    - `include_inactive`: Set to `true` to show inactive amenities
- `GET /api/amenity-types/`: Get all amenity types

### Admin Interface
- `http://localhost:8000/admin/`
- Manage amenity types and individual amenities
- View active/inactive status
- Edit position descriptions and GPS coordinates

## Data Model

### AmenityType
- `name`: Type name (e.g., "Water Fountain")
- `icon`: Icon identifier
- `color`: Hex color for map markers

### Amenity
- `name`: Display name
- `amenity_type`: Foreign key to AmenityType
- `latitude`/`longitude`: GPS coordinates (indexed for performance)
- `address`: Street address
- `position`: Text description of location (from NYC data)
- `description`: Additional details
- `active`: Boolean - whether amenity is operational (indexed)
- `external_id`: Reference to external dataset (e.g., NYC ID)
- `created_at`/`updated_at`: Timestamps

## Performance Optimizations
- Database indexes on latitude/longitude for fast bounding box queries
- Index on active status for filtering
- `select_related` in queries to minimize database hits
- Bounding box filtering reduces data transfer and memory usage
- Amenity markers cached in frontend to avoid recreating DOM elements

## Customization

### Add More Datasets
Update `import_nyc_water_fountains.py` or create new import commands following the same pattern.

### Change Map Tile Provider
Edit `maps/static/maps/js/map.js` - replace the `L.tileLayer()` URL with a different provider (Mapbox, etc.)

### Adjust Map Styling
Edit `maps/static/maps/css/style.css` for colors, layout, and responsive design.

## Troubleshooting

**"Locating..." stays frozen**
- Check browser console (F12) for geolocation errors
- May be permission denied or unavailable
- Click the location button to retry
- Uses USA center as fallback if geolocation fails

**No water fountains showing**
- Run the import command: `python manage.py import_nyc_water_fountains`
- Check that amenities exist in admin: `http://localhost:8000/admin/maps/amenity/`
- Try panning map to different area
- Check browser network tab (F12) to see API responses

**Map won't load**
- Run migrations: `python manage.py migrate`
- Ensure staticfiles are collected: `python manage.py collectstatic --noinput`
- Check Django logs in terminal for errors
