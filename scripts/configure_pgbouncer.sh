#!/bin/bash
set -e

# Safely load environment variables from the .env file
if [ -f /home/ec2-user/app/.env ]; then
  set -a
  source /home/ec2-user/app/.env
  set +a
else
  echo "No .env file found at /home/ec2-user/app/.env. Skipping PgBouncer configuration."
  exit 0
fi

mkdir -p /etc/pgbouncer

# Fallback variables
RDS_PORT="${RDS_PORT:-5432}"
RDS_DB_NAME="${RDS_DB_NAME:-amenities}"
RDS_HOSTNAME="${RDS_HOSTNAME:-localhost}"
EFFECTIVE_PASSWORD="${DB_PASSWORD:-${RDS_PASSWORD:-mypassword}}"

if [ -n "$APP_ENV" ]; then
  DB_USER="${RDS_DB_NAME}_${APP_ENV}"
else
  DB_USER="${DB_USER:-${RDS_DB_NAME}}"
fi

# Generate pgbouncer.ini
printf '[databases]\n%s = host=%s port=%s dbname=%s\n\n[pgbouncer]\nlisten_port = 6432\nlisten_addr = 127.0.0.1\nauth_type = md5\nauth_file = /etc/pgbouncer/userlist.txt\nlogfile = /var/log/pgbouncer/pgbouncer.log\npidfile = /var/run/pgbouncer/pgbouncer.pid\npool_mode = transaction\nmax_client_conn = 1000\ndefault_pool_size = 25\nreserve_pool_size = 5\nreserve_pool_timeout = 3\n' "$RDS_DB_NAME" "$RDS_HOSTNAME" "$RDS_PORT" "$RDS_DB_NAME" > /etc/pgbouncer/pgbouncer.ini

# Generate userlist.txt
printf '"%s" "%s"\n' "$DB_USER" "$EFFECTIVE_PASSWORD" > /etc/pgbouncer/userlist.txt

chown pgbouncer:pgbouncer /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt
chmod 640 /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt