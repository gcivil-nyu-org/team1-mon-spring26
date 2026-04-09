Main: [![Build Status](https://app.travis-ci.com/gcivil-nyu-org/team1-mon-spring26.svg?token=dcYXppMHqANaxxTZhnsR&branch=main)](https://app.travis-ci.com/gcivil-nyu-org/team1-mon-spring26) [![Coverage Status](https://coveralls.io/repos/github/gcivil-nyu-org/team1-mon-spring26/badge.svg?branch=main)](https://coveralls.io/github/gcivil-nyu-org/team1-mon-spring26?branch=main)

Develop: [![Build Status](https://app.travis-ci.com/gcivil-nyu-org/team1-mon-spring26.svg?token=dcYXppMHqANaxxTZhnsR&branch=develop)](https://app.travis-ci.com/gcivil-nyu-org/team1-mon-spring26) [![Coverage Status](https://coveralls.io/repos/github/gcivil-nyu-org/team1-mon-spring26/badge.svg?branch=develop)](https://coveralls.io/github/gcivil-nyu-org/team1-mon-spring26?branch=develop)

# django_map
Django map application for NYC Essentials Now

## Production Deployment (AWS EC2 + GitHub Actions)

This project is configured to deploy automatically to self-healing AWS EC2 Spot Instances via GitHub Actions. Traffic is securely routed to the instance using dynamically updated Cloudflare AAAA DNS records (IPv6 only) to eliminate AWS public IPv4 charges.

### 1. Infrastructure Provisioning (Terraform)
Before deploying code, provision the underlying infrastructure:
1. Navigate to the `terraform/` directory.
2. Create a `terraform.tfvars` file with your AWS VPC, Subnet, and Cloudflare credentials.
3. Run `terraform init` and `terraform apply`. Note the `environment` variable you pass (defaults to `staging`), as this tag is used to route deployments.

### 2. Application Secrets (AWS SSM Parameter Store)
App secrets (like database passwords) are deliberately excluded from GitHub. The EC2 instance securely downloads them directly from AWS when it boots.
1. In the **AWS Console**, navigate to **Systems Manager > Parameter Store**.
2. Create a new parameter named `/nycnow/env/<APP_ENV>` (e.g., `/nycnow/env/staging` or `/nycnow/env/feature`).
3. Type: **SecureString**.
4. Value: Paste your `.env` file contents. It must include the following explicit parameters:

```env
# Core Django
SECRET_KEY=your_secure_random_secret_key
DJANGO_DEBUG=0
APP_ENV=staging  # Matches your environment (staging, prod, feature, etc.)

# Database (RDS)
RDS_HOSTNAME=your-rds-endpoint.us-east-2.rds.amazonaws.com
RDS_PORT=5432
RDS_DB_NAME=amenities
DB_PASSWORD=your_secure_db_password
# DB_USER is automatically derived as RDS_DB_NAME_APP_ENV (e.g., amenities_staging)

# AWS S3 Storage (For Media Uploads)
AWS_S3_BUCKET_NAME=your-s3-bucket-name
AWS_S3_REGION_NAME=us-east-2

# Google OAuth (Optional)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```
*(Note: Additional email configuration variables like `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, and `EMAIL_HOST_PASSWORD` can also be added here for production SMTP).*

### 3. CI/CD Pipeline (GitHub Actions)
Configure the following in your GitHub repository under **Settings > Secrets and variables > Actions**:

**Repository Secrets:**
* `AWS_ACCESS_KEY_ID`: AWS IAM access key for a user with SSM command execution permissions.
* `AWS_SECRET_ACCESS_KEY`: Secret key for the IAM user.

**Repository Variables:**
* `APP_ENV`: The environment name (e.g., `staging`, `prod`, `feature`). The deployment script uses this to target the correct EC2 instances. Defaults to `feature` if unset.

### Multi-Environment Architecture
The GitHub Actions workflow (`.github/workflows/deploy.yml`) routes deployments by querying AWS Systems Manager (SSM) for instances matching specific tags (e.g., `App=NycNow` and `Environment=${APP_ENV}`). 

To support multiple environments based on repository or branch:
1. **Provision separately**: Run Terraform multiple times with different `-var="environment=prod"` tags. Create separate SSM Parameter Store paths for each environment's `.env` file (updating `userdata.sh` to match).
2. **Route via GitHub**: You can utilize GitHub Environments to dynamically inject the `APP_ENV` variable based on the branch being pushed to, or duplicate the deployment workflow file to trigger selectively on `main` vs `develop` branches.
