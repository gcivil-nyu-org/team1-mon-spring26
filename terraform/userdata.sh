#!/bin/bash
set -e

# Log all execution for easier debugging
exec > >(tee /var/log/userdata-execution.log) 2>&1

# 1. System Updates & Dependencies
dnf update -y
dnf install -y git python3.11 python3.11-pip nginx

# Install PgBouncer using the repository previously used in Elastic Beanstalk
dnf install -y spal-release
dnf install -y pgbouncer

# 2. Install Cloudflare WARP (Provides outbound IPv4 access for GitHub and AWS SSM)
curl -fsSl https://pkg.cloudflareclient.com/cloudflare-warp-ascii.repo | tee /etc/yum.repos.d/cloudflare-warp.repo
dnf install -y cloudflare-warp
systemctl enable --now warp-svc
sleep 2
warp-cli --accept-tos registration new || true
# Exclude all IPv6 traffic from the tunnel so native IPv6 (like your SSH connection) routes directly
# Trying older and newer v2024+ CLI syntaxes since Cloudflare changed the command
warp-cli --accept-tos tunnel ip add-range ::/0
warp-cli --accept-tos connect || true
sleep 5 # Give the daemon a few seconds to establish the IPv4 tunnel

# 3. Get the assigned IPv6 address from AWS Instance Metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
MAC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/mac)

for i in {1..10}; do
  IPV6=$(curl -s -f -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/ipv6s | head -n 1 || true)
  if [ -n "$IPV6" ] && [[ "$IPV6" != *"Not Found"* ]] && [[ "$IPV6" != *"<?xml"* ]]; then break; fi
  echo "Waiting for IPv6 address to be assigned..."
  sleep 2
done

# 4. Setup User Application Directory & Fetch Secrets
mkdir -p /home/ec2-user/app
chown -R ec2-user:ec2-user /home/ec2-user/app

REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
aws ssm get-parameter --name "/nycnow/env/${ENVIRONMENT}" --with-decryption --query "Parameter.Value" --output text --region $REGION > /home/ec2-user/app/.env

chown ec2-user:ec2-user /home/ec2-user/app/.env
chmod 600 /home/ec2-user/app/.env

# Load secrets into current shell
set -a
source /home/ec2-user/app/.env
set +a

# 5. Dynamically update Cloudflare DNS Records (Proxied)
CF_API_URL="https://api.cloudflare.com/client/v4/zones/$${CF_ZONE_ID}/dns_records"

update_cloudflare_record() {
  local record_type=$1
  local ip_address=$2
  
  if [ -z "$ip_address" ]; then
    echo "No valid IP found for $record_type record. Skipping."
    return
  fi

  echo "Updating Cloudflare $record_type Record to $ip_address..."
  RECORD_ID=$(curl -s -X GET "$CF_API_URL?type=$record_type&name=$${CF_RECORD_NAME}" \
    -H "Authorization: Bearer $${CF_API_TOKEN}" \
    -H "Content-Type: application/json" | grep -o '"id":"[^"]*' | head -n 1 | cut -d'"' -f4)

  local HTTP_METHOD="POST"
  local URL_PATH="$CF_API_URL"
  if [ -n "$RECORD_ID" ]; then
    HTTP_METHOD="PUT"
    URL_PATH="$CF_API_URL/$RECORD_ID"
  fi

  RESULT=$(curl -s -X $HTTP_METHOD "$URL_PATH" -H "Authorization: Bearer $${CF_API_TOKEN}" -H "Content-Type: application/json" --data "{\"type\":\"$record_type\",\"name\":\"$${CF_RECORD_NAME}\",\"content\":\"$ip_address\",\"ttl\":1,\"proxied\":false}")
  echo "Cloudflare API Response: $RESULT"
}

update_cloudflare_record "AAAA" "$${IPV6}"

# 6. Restart AWS SSM Agent to instantly register over the new WARP IPv4 tunnel
systemctl restart amazon-ssm-agent

# 7. Provision Systemd Services and Nginx
cat << 'EOF' > /etc/systemd/system/django-wsgi.service
[Unit]
Description=Gunicorn daemon for Django WSGI
After=network.target

[Service]
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/app
EnvironmentFile=/home/ec2-user/app/.env
ExecStart=/home/ec2-user/app/venv/bin/gunicorn django_map.wsgi:application -c gunicorn_config.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat << 'EOF' > /etc/systemd/system/django-asgi.service
[Unit]
Description=Uvicorn daemon for Django ASGI (SSE)
After=network.target

[Service]
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/app
EnvironmentFile=/home/ec2-user/app/.env
ExecStart=/home/ec2-user/app/venv/bin/uvicorn django_map.asgi:application --host 127.0.0.1 --port 8001
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat << 'EOF' > /etc/nginx/conf.d/django.conf
server {
    listen 80;
    server_name amenity.help *.amenity.help localhost;
    location /static/ { alias /home/ec2-user/app/static/; access_log off; expires 30d; add_header Cache-Control "public, max-age=2592000"; }
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; }
    location /api/chats/events/ { proxy_pass http://127.0.0.1:8001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; proxy_set_header Connection ""; proxy_http_version 1.1; proxy_read_timeout 86400s; proxy_send_timeout 86400s; proxy_buffering off; proxy_cache off; chunked_transfer_encoding on; }
}
EOF

systemctl daemon-reload
systemctl enable django-wsgi django-asgi nginx

# (GitHub Actions handles the rest on its next run!)