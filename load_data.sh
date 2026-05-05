echo "Loading data into the database..."
echo "Env variables:"
echo "APP_ENV: $APP_ENV"
echo "RDS_DB_NAME: $RDS_DB_NAME"
echo "RDS_DB_USER: $RDS_DB_USER"
echo "RDS_DB_HOST: $RDS_DB_HOST"
echo "RDS_DB_PORT: $RDS_DB_PORT"

# If this is a fresh instance (no db.sqlite3), restore it from S3
if [ ! -f "db.sqlite3" ]; then
    echo "Fresh instance detected. Restoring SQLite database from S3..."
    aws s3 cp s3://${AWS_S3_BUCKET_NAME}/database/db.sqlite3 db.sqlite3 || echo "No existing database found in S3, starting fresh."
fi

python manage.py migrate

# Dynamically update the default Django Site domain for emails (allauth)
echo "Updating Django Site domain to match environment..."
python manage.py shell -c "
import os
from django.contrib.sites.models import Site
domain = os.environ.get('CF_RECORD_NAME', 'test.amenity.help')
Site.objects.update_or_create(id=1, defaults={'domain': domain, 'name': 'NYC Now'})
"

python manage.py create_dynamodb_table

echo "Setting up background data imports..."
cat << 'EOF' > /home/ec2-user/app/run_imports.sh
#!/bin/bash
source /home/ec2-user/app/venv/bin/activate
export $(cat /home/ec2-user/app/.env | xargs)
python manage.py import_nyc_water_fountains && python manage.py import_nyc_public_restrooms && python manage.py import_cooling_sites && python manage.py import_linknyc_kiosks && python manage.py import_bike_racks
EOF
chmod +x /home/ec2-user/app/run_imports.sh

if [ ! -f "/home/ec2-user/app/.imports_started" ]; then
    nohup /home/ec2-user/app/run_imports.sh > /home/ec2-user/app/imports.log 2>&1 &
    touch /home/ec2-user/app/.imports_started
fi

echo "Setting up automatic S3 backup for SQLite database..."
cat << 'EOF' > /home/ec2-user/app/backup_db.py
import sqlite3
import os
import subprocess

db_path = '/home/ec2-user/app/db.sqlite3'
backup_path = '/home/ec2-user/app/db_backup.sqlite3'
state_file = '/home/ec2-user/app/.db_last_mtime'
bucket = os.environ.get('AWS_S3_BUCKET_NAME')

if os.path.exists(db_path) and bucket:
    current_mtime = os.path.getmtime(db_path)
    last_mtime = 0.0
    
    if os.path.exists(state_file):
        try:
            with open(state_file, 'r') as f:
                last_mtime = float(f.read().strip())
        except ValueError:
            pass
            
    if current_mtime > last_mtime:
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(backup_path)
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        
        subprocess.run(['aws', 's3', 'cp', backup_path, f's3://{bucket}/database/db.sqlite3'], stdout=subprocess.DEVNULL)
        
        with open(state_file, 'w') as f:
            f.write(str(current_mtime))
EOF

cat << 'EOF' > /home/ec2-user/app/backup_db.sh
#!/bin/bash
export $(cat /home/ec2-user/app/.env | xargs)
/home/ec2-user/app/venv/bin/python /home/ec2-user/app/backup_db.py
EOF
chmod +x /home/ec2-user/app/backup_db.sh

(crontab -l 2>/dev/null | grep -v backup_db.sh; echo "0 * * * * /home/ec2-user/app/backup_db.sh") | crontab -
/home/ec2-user/app/backup_db.sh

echo "Registering shutdown hook for database backup..."
sudo bash -c "cat << 'EOF' > /etc/systemd/system/db-backup-on-shutdown.service
[Unit]
Description=Backup SQLite DB to S3 on shutdown
Requires=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=/bin/true
ExecStop=/home/ec2-user/app/backup_db.sh
User=ec2-user
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable db-backup-on-shutdown.service
sudo systemctl start db-backup-on-shutdown.service
