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

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "NycNow-EC2-Profile"
  role = aws_iam_role.ec2_role.name
}

# --- 2. Security Group ---
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
  
  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# --- 3. Amazon Linux 2023 AMI ---
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

# --- 4. Launch Template (Spot Instance & Boot Script) ---
resource "aws_launch_template" "app_lt" {
  name_prefix   = "nycnow-lt-"
  image_id      = data.aws_ami.al2023.id
  instance_type = "t3.small" # Adjust to your preferred instance type

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  network_interfaces {
    associate_public_ip_address = false
    ipv6_address_count          = 1
    security_groups             = [aws_security_group.app_sg.id]
  }

  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price = "0.05" # Optional: Max hourly price you are willing to pay
    }
  }

  # Boot script executed every time a new Spot instance spawns
  user_data = base64encode(templatefile("${path.module}/userdata.sh", {
    CF_API_TOKEN   = var.cf_api_token
    CF_ZONE_ID     = var.cf_zone_id
    CF_RECORD_NAME = var.cf_record_name
  }))
}

# --- 5. Auto Scaling Group (Self-Healing) ---
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
}