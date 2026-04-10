#!/bin/bash
set -e

# Log all execution for easier debugging
exec > >(tee /var/log/userdata-execution.log) 2>&1

# 1. System Updates & Dependencies
dnf update -y
dnf install -y git python3.14 python3.14-pip nginx

# Install PgBouncer using the repository previously used in Elastic Beanstalk
dnf install -y spal-release
dnf install -y pgbouncer

# Install GDAL & GEOS for geospatial support (required by PostGIS and Django's GIS features)
dnf install -y gdal310 geos

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

# Install Cloudflare Origin CA certificates for Nginx
mkdir -p /etc/pki/tls/certs

cat << 'EOF' > /etc/pki/tls/certs/server.crt
-----BEGIN CERTIFICATE-----
MIIEpDCCA4ygAwIBAgIUGK3x6G39dGwnzknEKPyvg79DwrYwDQYJKoZIhvcNAQEL
BQAwgYsxCzAJBgNVBAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMTQw
MgYDVQQLEytDbG91ZEZsYXJlIE9yaWdpbiBTU0wgQ2VydGlmaWNhdGUgQXV0aG9y
aXR5MRYwFAYDVQQHEw1TYW4gRnJhbmNpc2NvMRMwEQYDVQQIEwpDYWxpZm9ybmlh
MB4XDTI2MDIyNDA3MTEwMFoXDTQxMDIyMDA3MTEwMFowYjEZMBcGA1UEChMQQ2xv
dWRGbGFyZSwgSW5jLjEdMBsGA1UECxMUQ2xvdWRGbGFyZSBPcmlnaW4gQ0ExJjAk
BgNVBAMTHUNsb3VkRmxhcmUgT3JpZ2luIENlcnRpZmljYXRlMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA29PtlInqv1d9qypF4s5/46xJYqX43glqrajO
YALDeaRnY811QrjDlQBLL6GGUPjcJUf8jnmMqZaba5I2qkkQLTDvg97sb9Ho/BgV
edXidEehrCzVWgearmDTJEOSduh12aPn2eJH59MdfYkJxSi6a0hgWOuFkwMi4iLZ
5vey6MfeubDcEzcR//zmXRieS73geSEftV8z8PFq+HT02ddgCIoZm0aFR7pvstcg
1nu0qHgr8Skg0eLs0J7bG0Hw9fkY1nJfzu3R3BqfxYy/AqgPBySLKh9kpwQsnofA
VHhvD91diSYzLpXfTStYw+78TCEvGtzTCe8qwIXEojCD2aGLNwIDAQABo4IBJjCC
ASIwDgYDVR0PAQH/BAQDAgWgMB0GA1UdJQQWMBQGCCsGAQUFBwMCBggrBgEFBQcD
ATAMBgNVHRMBAf8EAjAAMB0GA1UdDgQWBBSVAkZ3JDgHDNhURAieagx5ejmgSjAf
BgNVHSMEGDAWgBQk6FNXXXw0QIep65TbuuEWePwppDBABggrBgEFBQcBAQQ0MDIw
MAYIKwYBBQUHMAGGJGh0dHA6Ly9vY3NwLmNsb3VkZmxhcmUuY29tL29yaWdpbl9j
YTAnBgNVHREEIDAegg4qLmFtZW5pdHkuaGVscIIMYW1lbml0eS5oZWxwMDgGA1Ud
HwQxMC8wLaAroCmGJ2h0dHA6Ly9jcmwuY2xvdWRmbGFyZS5jb20vb3JpZ2luX2Nh
LmNybDANBgkqhkiG9w0BAQsFAAOCAQEAUxg1psSzPZY7WF7dsO26xCS/qZm7owxW
kCfoJnyXv7RW235DNQ33r4rbr54yw7zycC88OVZSQCMYVbZn7GcUtu9LROoALYws
adA6X8XXD6nOiquibA0SJcOYOhr+GmBvp7+yE+a1akN9Ble+/D4ExbpKOJpWWHGC
/KqI61L+2gFmjWmKCrhF6KJ5/nbksHkF64oh9SVoEVLWAC2Cpzynb0bO1p4KWDcc
KYsaoChwyjfLdFpD6XlR8KnylrIhHf5bGWG6rkMacin2UCbYDsH6kgfmG4E87n8/
1w8Th8HBjIjxMgBRVq2SN0gZwBgmNaWjglpL14CUaKtsoaUVEA+ZEQ==
-----END CERTIFICATE-----
EOF

cat << 'EOF' > /etc/pki/tls/certs/server.key
-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDb0+2Uieq/V32r
KkXizn/jrElipfjeCWqtqM5gAsN5pGdjzXVCuMOVAEsvoYZQ+NwlR/yOeYyplptr
kjaqSRAtMO+D3uxv0ej8GBV51eJ0R6GsLNVaB5quYNMkQ5J26HXZo+fZ4kfn0x19
iQnFKLprSGBY64WTAyLiItnm97Lox965sNwTNxH//OZdGJ5LveB5IR+1XzPw8Wr4
dPTZ12AIihmbRoVHum+y1yDWe7SoeCvxKSDR4uzQntsbQfD1+RjWcl/O7dHcGp/F
jL8CqA8HJIsqH2SnBCyeh8BUeG8P3V2JJjMuld9NK1jD7vxMIS8a3NMJ7yrAhcSi
MIPZoYs3AgMBAAECggEALg/zzfayQkLOeeHDQBm+EZJl1C5r/faiLF5dVB/wHtqU
sYR5SDBYBy5HEuV5NBlZY9R4NtCAaX699WXvX3Is2hNRdOPuziWBeOWBBoULTQs/
dMj2McW7I0P1qjkghRsDqsWeDPlN0OVbXhUrf20f1uAVFDzRwfLbyd+8ohmQGxd2
38KEX67UZhTfsKxuW8qeI8jAMtz2G+PBwIbGIUDnlKUoGMpFP29WvAmL9WJN6tk8
zrZQs3Vq6kAZ2cG4kjVUgg+R24xSG1NRZXA4Rbd5C0yeWKfIaMWS/pjwq5fCC4Zc
VWKJp32kfi9mNzpKrNLkw0YtrsPv4fbwNqHwjvJQaQKBgQD7FvveLhKi2CIp5lxX
s+L0NxrpUlyteYyY24M2U6i3zTAMbkeG7Fcs4RNbRW/1/Zu1FGciZm+Zy1nECtCZ
D5zDXwMwfWzsmX3eViwWJ9gjJCgkWEZW1XkRQkdPaGTQ7d9X3iVMjIhQmh+wWe+d
oEEkPSDZqQm5xfppkPKtssCKmQKBgQDgIHB681pdHKoJ2HHbTgsAa8P6YrotMWyG
y2Ku7f+W5NlQtQKI6x/i0N1bm3Y4xOHlQFcvx0TcmEBv4uFuWJTchRaLSTkhcWCA
NinUbm7R+CaarSh+yZfJqLQSZdQJcu/sE8+LtOKULIvSpRoAaAuY/41CIS0NK/en
D0zIpd62TwKBgQCWk5P8C9k1OzRRuEoMdl5WYm2LGs9lYQ1F5e5sOANoJm74JXJT
oYwt59R52cxo0uv7zf6DjLbEnkR44ptyDwDN0T7SZ4VY5juriDXsG3zsphREp4OX
M3HlPcASCOLcwKo9wYTQwT5GSAdU9LpT5vTpzJbUsSCZ/fZMNJa0QAxjkQKBgQCw
hbwxijN0vJvMD1Z1dL1Dgp0jOtkJuTCR5eR+hGLW1L24TCiH8C/386s0eHgfdCm6
5vcEYX0CBURTGy2UPF5aZNQBthUyGtr3gDFn5+aOp1S4ZINNgLd1E9Nn3h2np4gB
twSzMy91prQlnvWgtlHUGgqGuByEkEmIoYtHSSTlDwKBgQDitkiQACfjrdEzDBWX
1ch/zR2FYThXT6whQJ6R55ouhJ8iDBLDUup+qffpI7zCiMFV3+eZdcG2dBrXOiLs
N1v3hPrYT6DvKL+IwYOEeZXG1voGHxtEdiIVM1/9pRJjDSLS3eYr6Y13Oh0MXQpE
Pyn0vd64PRbhBO9nfrmIfAWKVw==
-----END PRIVATE KEY-----
EOF

chmod 400 /etc/pki/tls/certs/server.crt /etc/pki/tls/certs/server.key

# Create OSM cache directory
mkdir -p /var/cache/osm_tile_cache
chown -R nginx:nginx /var/cache/osm_tile_cache

systemctl daemon-reload
systemctl enable django-wsgi django-asgi nginx pgbouncer

# (GitHub Actions handles the rest on its next run!)