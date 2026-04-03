echo "Loading data into the database..."
echo "Env variables:"
echo "APP_ENV: $APP_ENV"
echo "RDS_DB_NAME: $RDS_DB_NAME"
echo "RDS_DB_USER: $RDS_DB_USER"
echo "RDS_DB_HOST: $RDS_DB_HOST"
echo "RDS_DB_PORT: $RDS_DB_PORT"

python manage.py migrate
python manage.py import_nyc_water_fountains
python manage.py import_nyc_public_restrooms
python manage.py import_cooling_sites
python manage.py import_bike_racks
python manage.py import_linknyc_kiosks
