---
sidebar_position: 5
title: "Architecture"
description: "Complete infrastructure architecture for fork deployments with customer-owned AWS infrastructure"
content_type: ["architecture", "how-to"]
feature_status: stable
audience: ["administrators", "devops", "developers"]
spiciness: hot
visibility: public
maturity: approved
tags: ["technical_docs", "aws", "deployment", "security", "infrastructure", "vpc", "costs"]
last_reviewed: 2025-01-12
review_cycle: quarterly
---

# Fork Deployment Architecture

This document describes the infrastructure architecture for customer fork deployments of Bike4Mind.

## Overview

**Key Point: Your deployment runs entirely in your own AWS account.**

No traffic flows through Bike4Mind's infrastructure. Bike4Mind provides the code and packages, but you own and operate all the infrastructure. This means:

- You have full control over your data
- You manage your own AWS costs
- You configure security according to your requirements
- All services run in your AWS account (typically us-east-2)

## VPC Configuration

Each fork deployment creates its own VPC with the following configuration:

| Component | Configuration |
|-----------|---------------|
| Availability Zones | Single AZ (cost-optimized) |
| NAT Gateway | EC2-based NAT (not managed NAT Gateway) |
| Private Subnets | Lambda and ECS workloads |
| Public Subnets | Load balancer routing only |

The VPC is created automatically during deployment, or you can use an existing VPC by setting the `VPC_ID` environment variable.

**To find your VPC ID:**
- AWS Console → VPC → Your VPCs (in your account, us-east-2 region)
- Or run: `aws ec2 describe-vpcs --region us-east-2`

For detailed VPC setup steps, see [Prerequisites](./prerequisites.md).

## Traffic Flow

All traffic stays within your AWS account:

```
User Browser (HTTPS)
    ↓
CloudFront (CDN/Router) ← Only public entry point
    ↓
Next.js Lambda (in private VPC subnet)
    ├── DocumentDB/MongoDB (in VPC, no public access)
    ├── S3 Buckets (CloudFront-only access)
    ├── SQS Queues (private)
    └── External AI APIs (outbound only via NAT):
        • Amazon Bedrock (same AWS account)
        • OpenAI API (external)
        • Anthropic API (external)
        • Google Gemini (external)
```

### Data Location

| Data Type | Storage Location | Access Method |
|-----------|------------------|---------------|
| User data, sessions, chat history | DocumentDB/MongoDB in VPC | Lambda only (no public access) |
| Uploaded files | S3 (private bucket) | Signed URLs via Lambda |
| Generated images | S3 (CloudFront bucket) | Public via CloudFront CDN |
| Queue messages | SQS (encrypted) | Lambda subscribers only |

### Security Measures

- All Lambda functions run in private VPC subnets
- DocumentDB/MongoDB has NO public internet access
- S3 buckets blocked from direct access (CloudFront-only)
- SQS queues encrypted with AWS-managed KMS keys
- All secrets stored in AWS Secrets Manager (never in environment variables)

## Security Architecture

### Network Isolation

| Component | Network Access |
|-----------|----------------|
| CloudFront | Public (only entry point) |
| Next.js Lambda | Private subnet, no direct internet |
| WebSocket API Gateway | Public endpoint, but handlers run in VPC |
| DocumentDB/MongoDB | Private subnet only, no public access |
| SQS Queues | Private (AWS service, no public endpoint) |
| ECS Fanout Service | Private subnet in VPC |

### Protection from Public Access

| Protection | Status |
|------------|--------|
| Database completely isolated in VPC | ✅ Protected |
| Lambda functions in private subnets (outbound only via NAT) | ✅ Protected |
| S3 buckets blocked from direct public access | ✅ Protected |
| Secrets in AWS Secrets Manager (IAM-controlled) | ✅ Protected |
| CloudFront publicly accessible | ⚠️ Required for app access |
| WebSocket API publicly accessible | ⚠️ Required for real-time features |

### Addressing "Unsecured AI Instance" Concerns

This architecture does NOT expose any AI endpoints publicly:

- AI calls (Bedrock, OpenAI, etc.) are made from Lambda functions inside private subnets
- All AI API calls require API keys stored in Secrets Manager
- No direct public access to any AI processing
- This is NOT like spinning up an unsecured AI instance on the internet

The architecture follows AWS Well-Architected Framework security principles.

## Security & Compliance

### Identity & Access Management (IAM)

**Principle**: All access follows least-privilege. Each component has minimal required permissions.

| Component | Permissions |
|-----------|-------------|
| Lambda Functions | S3 read, DocumentDB access, Secrets Manager read (no admin privileges) |
| DocumentDB | VPC-only access via security groups, no public endpoint |
| S3 Buckets | CloudFront-only access via bucket policies, no direct public access |
| External APIs | API keys stored in Secrets Manager with IAM-controlled access |
| ECS Fargate | Task role with minimal permissions for WebSocket management |

### Encryption

| Component | At Rest | In Transit | Key Management |
|-----------|---------|------------|----------------|
| DocumentDB/MongoDB | ✅ AWS KMS | ✅ TLS 1.2+ | AWS-managed or customer KMS |
| S3 Buckets | ✅ S3-managed (AES-256) | ✅ TLS 1.2+ | S3-managed encryption |
| SQS Queues | ✅ AWS-managed KMS | ✅ TLS 1.2+ | AWS-managed (`alias/aws/sqs`) |
| Secrets Manager | ✅ KMS encrypted | ✅ TLS 1.2+ | AWS KMS |
| CloudFront | N/A (CDN) | ✅ TLS 1.2+ | AWS-managed certificates |

### Compliance Considerations

| Framework | Coverage |
|-----------|----------|
| **SOC 2** | SOC 2-aligned controls including CloudTrail audit logging, IAM access controls, Git change management |
| **GDPR** | Customer data stored in customer's chosen AWS region, deletion procedures available |
| **Audit Trail** | All API calls logged to CloudTrail (365-day retention recommended) |


### Monitoring & Logging

| Log Type | Retention | Storage |
|----------|-----------|---------|
| CloudTrail (API calls) | 365 days | S3 bucket |
| Lambda application logs | 3-7 days | CloudWatch Logs |
| API Gateway access logs | 30 days | CloudWatch Logs |
| DocumentDB audit logs | 90 days | CloudWatch/S3 |

**Recommended Alerts**:
- Lambda error rate exceeds 1%
- DocumentDB CPU utilization exceeds 80%
- API Gateway 5xx error rate exceeds 0.1%

### Disaster Recovery

| Aspect | Configuration |
|--------|---------------|
| **Database Backups** | Continuous (MongoDB Atlas) or daily snapshots (DocumentDB) |
| **S3 Data** | Versioning enabled, cross-region replication optional |
| **Recovery** | Point-in-time recovery available for database |
| **RTO/RPO** | Varies by database choice and configuration |


## Cost Estimates

Check your actual costs in AWS Console → Billing → Cost Explorer. Below are rough estimates based on the infrastructure:

### Estimated Monthly Costs (us-east-2 pricing)

| Usage Tier | Requests/Month | Est. Monthly Cost | Cost/Request |
|------------|----------------|-------------------|--------------|
| **Low** | ~3,000 (100/day) | ~$100-150 | $0.03-0.05 |
| **Medium** | ~30,000 (1,000/day) | ~$225-300 | $0.008-0.01 |
| **High** | ~300,000 (10,000/day) | ~$1,400-1,800 | $0.005-0.006 |

### Cost Breakdown by Component

| Component | Low Usage | Medium Usage | High Usage |
|-----------|-----------|--------------|------------|
| Lambda (Quest Processor + Queues) | $17 | $76 | $661 |
| ECS Fargate (24/7) | $46 | $46 | $46 |
| NAT Gateway | $32 | $35 | $55 |
| CloudFront | $4 | $43 | $425 |
| S3 Storage + Requests | $1 | $5 | $26 |
| API Gateway WebSocket | $0.40 | $0.40 | $3 |
| SQS | Free tier | $0.12 | $1.20 |
| CloudWatch Logs | $0.50 | $1.50 | $15 |
| Bedrock (Claude + Images) | $1-5 | $18-25 | $180-200 |

### Costs NOT Included (Separate)

- **MongoDB Atlas**: $57-500+/month depending on tier
- **AWS DocumentDB**: ~$730+/month for smallest instance
- **External AI APIs** (OpenAI, Anthropic direct): Variable based on usage

### Key Cost Drivers

1. **Bedrock/LLM usage** - Highly variable, can be 3-20% of total depending on AI usage volume
2. **NAT Gateway** - Fixed ~$32/month baseline + data processing fees
3. **ECS Fargate** - Fixed ~$46/month for 24/7 subscriber fanout service
4. **CloudFront data transfer** - Scales with user traffic ($0.085/GB)

## Service Inventory

### Compute Services

| Service | Purpose | Configuration |
|---------|---------|---------------|
| Next.js Lambda | Frontend + API | 60s timeout, 1 warming instance (prod/dev) |
| Quest Processor Lambda | AI/LLM processing | 2GB RAM, 15min timeout, 3 provisioned concurrency (prod), 20 reserved concurrency |
| Image Processor Lambda | Image handling | 2GB RAM, 5min timeout |
| Queue Subscriber Lambdas (11) | Async processing | Various configs (1-2GB RAM, 6-15min timeouts) |
| ECS Fargate Service | Real-time WebSocket fanout | 2GB RAM, 0.25 vCPU |

### Storage Services (6 S3 Buckets)

| Bucket | Purpose |
|--------|---------|
| fabFileBucket | User-uploaded documents |
| generatedImagesBucket | AI-generated images |
| appFilesBucket | Profile photos, logos, org assets |
| historyImportBucket | Temp chat imports (7-day TTL) |
| slackExportBucket | Temp Slack exports (7-day TTL) |
| emailIngestionBucket | Incoming email storage (30-day TTL) |

### Data Retention Policies

| Data Type | Retention | Auto-Delete |
|-----------|-----------|-------------|
| historyImportBucket | 7 days | ✅ S3 lifecycle policy |
| slackExportBucket | 7 days | ✅ S3 lifecycle policy |
| emailIngestionBucket | 30 days | ✅ S3 lifecycle policy |
| Application logs | 3-7 days | ✅ CloudWatch retention |
| User data (database) | Customer-managed | ❌ Manual deletion |
| Uploaded files (fabFileBucket) | Customer-managed | ❌ Manual deletion |

**GDPR Considerations**: Customer data deletion requests should be handled through the application's user management interface. Database records and associated S3 files must be deleted together.

### Database

| Service | Purpose |
|---------|---------|
| DocumentDB or MongoDB Atlas | Primary database (users, sessions, quests, files metadata) |

For database setup, see [DocumentDB Setup](/databases/documentdb-setup).

### Messaging/Event Services (11 SQS Queues + 11 DLQs)

| Queue | Purpose |
|-------|---------|
| fabFileVectorizeQueue | Document embeddings |
| fabFileChunkQueue | Document chunking |
| imageGenerationQueue | AI image creation |
| imageEditQueue | Image manipulation |
| researchEngineQueue | Research tasks |
| whatsNewGenerationQueue | Feature announcements |
| notebookCurationQueue | Content curation |
| agentProactiveMessageQueue | Proactive agent messages |
| slackExportQueue | Slack channel exports |
| emailIngestionQueue | Email processing |
| emailAnalysisQueue | Email AI analysis |
| EventBridge | Event pub/sub (Stripe, session, curation events) |
| API Gateway WebSocket | Real-time client updates |

### CDN/Networking

| Service | Purpose |
|---------|---------|
| CloudFront | CDN, routing, caching |
| VPC + NAT (EC2-based) | Network isolation |

## Finding Your Infrastructure Details

Since you own all the infrastructure, find specific details in your AWS account:

| Information Needed | Where to Find It |
|-------------------|------------------|
| VPC ID | AWS Console → VPC → Your VPCs |
| Security Groups | AWS Console → VPC → Security Groups |
| Security Group Rules | Click on security group → Inbound/Outbound rules |
| Monthly Costs | AWS Console → Billing → Cost Explorer |
| Service Instances | AWS Console → Lambda, ECS, S3, etc. |
| Network ACLs | AWS Console → VPC → Network ACLs |

### Useful CLI Commands

Run these in your AWS account:

```bash
# List VPCs
aws ec2 describe-vpcs --region us-east-2

# List Security Groups
aws ec2 describe-security-groups --region us-east-2

# List Lambda functions
aws lambda list-functions --region us-east-2

# Get cost data (last 30 days)
aws ce get-cost-and-usage \
  --time-period Start=2024-12-01,End=2025-01-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

## Related Documentation

- [Deployment Guide](./index.md) - Getting started overview
- [Prerequisites](./prerequisites.md) - AWS account and VPC setup
- [DocumentDB Setup](/databases/documentdb-setup) - Database configuration
- [GitHub Actions Setup](./ci-cd/github-actions.md) - CI/CD deployment
