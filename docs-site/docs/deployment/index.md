---
title: Deployment Guide
description: Deploy B4M on your own AWS infrastructure - complete guide for fork customers
sidebar_position: 1
content_type: ["procedural"]
audience: ["administrators", "devops"]
feature_status: stable
visibility: public
maturity: approved
spiciness: moderate
tags:
  - deployment
  - aws
  - fork
  - infrastructure
last_reviewed: 2026-01-13
---

# Deployment Guide

This guide walks you through deploying B4M on your own AWS account. Your deployment runs entirely in your AWS infrastructure - no traffic flows through Bike4Mind's systems.

## Deployment Paths

| Path | Best For | CI/CD |
|------|----------|-------|
| **[GitHub Actions](./ci-cd/github-actions.md)** (Recommended) | Most customers | GitHub Actions |
| **[Seed](./ci-cd/seed.md)** | Legacy/existing Seed users | Seed CI/CD |

## Quick Start Checklist

- [ ] **[Prerequisites](./prerequisites.md)** - AWS account, VPC, Route53, database
- [ ] **[Secrets Configuration](./secrets-reference.md)** - SST secrets setup
- [ ] **[CI/CD Setup](./ci-cd/)** - GitHub Actions or Seed
- [ ] **[Initial Deployment](./domain-migration.md#phase-d-deployment)** - First deploy
- [ ] **[Custom Domain](./domain-migration.md)** - OAuth, DNS, SSL configuration

## Architecture Overview

Your fork deployment includes:

| Component | Purpose |
|-----------|---------|
| **CloudFront** | CDN and routing (only public entry point) |
| **Lambda** | Serverless compute (~15 functions) |
| **S3** | File storage (6 buckets) |
| **SQS** | Message queues (11 queues + DLQs) |
| **VPC** | Network isolation |
| **Bedrock** | AI/ML models |

See **[Architecture](./architecture.md)** for complete AWS services inventory, security architecture, VPC configuration, cost estimates, and compliance information.

## Key Concepts

### Environment-Driven Configuration

All configuration is environment-variable driven through SST. **No code changes required** for domain migration or deployment.

### Domain Pattern

B4M uses the `app.${SERVER_DOMAIN}` pattern:

| SERVER_DOMAIN | Resulting URL |
|---------------|---------------|
| `example.com` | `https://app.example.com` |
| `staging.example.com` | `https://app.staging.example.com` |

### Security Model

- All Lambda functions run in private VPC subnets
- Database has NO public internet access
- S3 buckets blocked from direct access (CloudFront-only)
- All secrets stored in AWS Secrets Manager

## Documentation Map

| Document | Purpose |
|----------|---------|
| [Prerequisites](./prerequisites.md) | AWS account setup, VPC, Route53 |
| [Secrets Reference](./secrets-reference.md) | All SST secrets with explanations |
| [Domain Migration](./domain-migration.md) | Custom domain and OAuth setup |
| [Architecture](./architecture.md) | Complete infrastructure reference |
| [CI/CD Setup](./ci-cd/) | GitHub Actions or Seed configuration |
| [Email Setup](./email/) | SES configuration for platform email |
| [Troubleshooting](./troubleshooting.md) | Common issues and solutions |

## Support

For deployment issues:
1. Check **[Troubleshooting](./troubleshooting.md)** for common problems
2. Review CloudWatch logs for detailed error messages
3. Use the **Admin > System Health** panel to verify configuration
4. Contact Bike4Mind support for complex issues
