#!/bin/bash
set -e

# 1. System Updates & Dependencies
dnf update -y
dnf install -y git python3 pip nginx pgbouncer

# 2. Get the assigned IPv6 address from AWS Instance Metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
MAC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/mac)

for i in {1..10}; do
  IPV6=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/ipv6s | head -n 1)
  if [ -n "$IPV6" ]; then break; fi
  sleep 2
done

# 3. Dynamically update Cloudflare AAAA Record (Proxied)
CF_API_URL="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"

# Check if the record already exists
RECORD_ID=$(curl -s -X GET "$CF_API_URL?type=AAAA&name=${CF_RECORD_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" | grep -o '"id":"[^"]*' | head -n 1 | cut -d'"' -f4)

if [ -n "$RECORD_ID" ]; then
  # Update existing record
  curl -s -X PUT "$CF_API_URL/$RECORD_ID" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"AAAA\",\"name\":\"${CF_RECORD_NAME}\",\"content\":\"$${IPV6}\",\"ttl\":1,\"proxied\":true}"
else
  # Create new record if missing
  curl -s -X POST "$CF_API_URL" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"AAAA\",\"name\":\"${CF_RECORD_NAME}\",\"content\":\"$${IPV6}\",\"ttl\":1,\"proxied\":true}"
fi

# 4. Setup User Application Directory
mkdir -p /home/ec2-user/app
chown -R ec2-user:ec2-user /home/ec2-user/app

# 5. Securely download the .env file from AWS Parameter Store
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
aws ssm get-parameter --name "/nycnow/env/${ENVIRONMENT}" --with-decryption --query "Parameter.Value" --output text --region $REGION > /home/ec2-user/app/.env

chown ec2-user:ec2-user /home/ec2-user/app/.env
chmod 600 /home/ec2-user/app/.env

# (GitHub Actions handles the rest on its next run!)