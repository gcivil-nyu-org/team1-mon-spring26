terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  default = "us-east-2"
}

variable "vpc_id" {
  description = "VPC ID where the instance will launch"
  type        = string
}

variable "subnet_ids" {
  description = "List of Subnets (Must have 'Auto-assign IPv6' enabled)"
  type        = list(string)
}

variable "environment" {
  description = "Environment name (e.g., dev, staging, feature)"
  type        = string
  default     = "feature"
}

# --- 1. IAM Role for Systems Manager (SSM) ---
# Allows GitHub Actions to SSH/Execute commands securely without a public IP
resource "aws_iam_role" "ec2_role" {
  name = "NycNow-EC2-SSM-Role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Allow the EC2 instance to read its .env secrets from SSM Parameter Store
resource "aws_iam_role_policy" "ssm_parameter_policy" {
  name = "NycNow-SSM-Parameter-Policy"
  role = aws_iam_role.ec2_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Effect   = "Allow"
        Resource = [
          # Restricts to only this environment's feature file
          "arn:aws:ssm:${var.aws_region}:*:parameter/nycnow/env/${var.environment}",
          
          # Allows all environments to access shared ssl parameters
          "arn:aws:ssm:${var.aws_region}:*:parameter/nycnow/env/ssl/*"
        ]
        }]
  })
}

# Allow the EC2 instance to dynamically assign itself an IPv6 address
resource "aws_iam_role_policy" "ec2_ipv6_policy" {
  name = "NycNow-EC2-IPv6-Policy"
  role = aws_iam_role.ec2_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = ["ec2:AssignIpv6Addresses", "ec2:DescribeNetworkInterfaces"]
      Effect = "Allow"
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "NycNow-EC2-Profile"
  role = aws_iam_role.ec2_role.name
}

# --- 2. IAM Role for GitHub Actions (OIDC) ---
resource "aws_iam_role" "github_actions_role" {
  name = "NycNow-GitHub-Actions-SSM-Role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # IMPORTANT: Make sure this matches your exact GitHub username/repo!
          "token.actions.githubusercontent.com:sub" = "repo:ajslezak/team1-mon-spring26:*"
        }
      }
    }]
  })
}

# Attach permission for GitHub to trigger SSM commands
resource "aws_iam_role_policy" "github_ssm_policy" {
  name = "NycNow-GitHub-SSM-Policy"
  role = aws_iam_role.github_actions_role.id 
  
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations",
          "ec2:DescribeInstances"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

# Data source to get your AWS Account ID automatically
data "aws_caller_identity" "current" {}


# --- 3. Security Group ---
resource "aws_security_group" "app_sg" {
  name_prefix = "nycnow-sg-"
  description = "Web traffic ingress and API egress"
  vpc_id      = var.vpc_id

  # Allow inbound HTTP from Cloudflare Edge Nodes over IPv6
  ingress {
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    from_port        = 22
    to_port          = 22
    protocol         = "tcp"
    ipv6_cidr_blocks = ["2601:2c3:c083:1ce0:15ab:c4bd:6b73:3afd/128"]
  }

  ingress {
    from_port        = -1
    to_port          = -1
    protocol         = "icmpv6"
    ipv6_cidr_blocks = ["::/0"]
  }
  
  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# --- 4. Amazon Linux 2023 AMI ---
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }
}

# --- 5. Launch Template (Spot Instance & Boot Script) ---
resource "aws_launch_template" "app_lt" {
  name_prefix   = "nycnow-lt-"
  image_id      = data.aws_ami.al2023.id
  instance_type = "t4g.small" # Adjust to your preferred instance type
  key_name      = "cloudflare-access"

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  network_interfaces {
    associate_public_ip_address = false
    ipv6_address_count          = 1
    security_groups             = [aws_security_group.app_sg.id]
  }

  private_dns_name_options {
    hostname_type                        = "ip-name"
    enable_resource_name_dns_aaaa_record = true
    enable_resource_name_dns_a_record    = true
  }

  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price = "0.005" # Optional: Max hourly price you are willing to pay
    }
  }

  # Boot script executed every time a new Spot instance spawns
  user_data = base64encode(templatefile("${path.module}/userdata.sh", {
    ENVIRONMENT    = var.environment
  }))
}

# --- 6. Auto Scaling Group (Self-Healing) ---
resource "aws_autoscaling_group" "app_asg" {
  name                = "nycnow-asg"
  vpc_zone_identifier = var.subnet_ids
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1

  launch_template {
    id      = aws_launch_template.app_lt.id
    version = "$Latest"
  }

  # Tagging is critical: GitHub Actions uses this tag to find the active instance
  tag {
    key                 = "App"
    value               = "NycNow"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }
}