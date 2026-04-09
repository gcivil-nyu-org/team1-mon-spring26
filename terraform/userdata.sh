#!/bin/bash
set -e

# Log all execution for easier debugging
exec > >(tee /var/log/userdata-execution.log) 2>&1

# 1. System Updates & Dependencies
dnf update -y
dnf install -y git python3 pip nginx pgbouncer

# 2. Install Cloudflare WARP (Provides outbound IPv4 access for GitHub and AWS SSM)
curl -fsSl https://pkg.cloudflareclient.com/cloudflare-warp-ascii.repo | tee /etc/yum.repos.d/cloudflare-warp.repo
dnf install -y cloudflare-warp
systemctl enable --now warp-svc
sleep 2
warp-cli --accept-tos registration new || true
warp-cli --accept-tos connect || true
sleep 5 # Give the daemon a few seconds to establish the IPv4 tunnel

# 3. Get the assigned IPv6 address from AWS Instance Metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
MAC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/mac)

ENI=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/interface-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

# Explicitly assign an IPv6 address and restart networking so the OS binds it
aws ec2 assign-ipv6-addresses --network-interface-id $ENI --ipv6-address-count 1 --region $REGION || true
systemctl restart systemd-networkd || true
sleep 5

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

  RESULT=$(curl -s -X $HTTP_METHOD "$URL_PATH" -H "Authorization: Bearer $${CF_API_TOKEN}" -H "Content-Type: application/json" --data "{\"type\":\"$record_type\",\"name\":\"$${CF_RECORD_NAME}\",\"content\":\"$ip_address\",\"ttl\":1,\"proxied\":true}")
  echo "Cloudflare API Response: $RESULT"
}

update_cloudflare_record "AAAA" "$${IPV6}"

# 6. Restart AWS SSM Agent to instantly register over the new WARP IPv4 tunnel
systemctl restart amazon-ssm-agent

# (GitHub Actions handles the rest on its next run!)