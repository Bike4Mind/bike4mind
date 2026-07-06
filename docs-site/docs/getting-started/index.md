---
title: Getting Started with Bike4Mind
description: Quick start guide to begin using Bike4Mind AI infrastructure platform
sidebar_position: 1
content_type: ["procedural"]
audience: ["developers", "administrators"]
feature_status: stable
visibility: public
maturity: approved
tags:
  - getting-started
  - setup
  - installation
last_reviewed: 2026-01-19
---

# Getting Started with Bike4Mind

Welcome to Bike4Mind! This guide will help you get up and running with our AI infrastructure platform.

## What You'll Learn

- How to set up your Bike4Mind development environment
- Basic concepts and terminology
- Your first AI agent interaction
- Key features overview

## Prerequisites

Before you begin, make sure you have:

| Requirement | Version | How to Check |
|-------------|---------|--------------|
| Node.js | 20.x | `node -v` |
| pnpm | 9.x+ | `pnpm -v` |
| AWS CLI | 2.x | `aws --version` |
| Git | Any | `git --version` |

**Install pnpm** if not already installed:

```bash
npm install -g pnpm
```

**For Fork Customers**: You'll also need:
- AWS account with proper IAM permissions
- AWS SSO configured for your organization
- See [Deployment Prerequisites](/deployment/prerequisites) for full requirements

## Quick Start (Fork Customers)

### 1. Clone the Repository

```bash
git clone git@github.com:bike4mind/bike4mind.git
cd bike4mind

```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Build Core Packages

```bash
pnpm core:build
```

### 4. Configure AWS

Add your AWS SSO configuration to `~/.aws/config`:

```ini
[sso-session your-org]
sso_start_url = https://your-org.awsapps.com/start
sso_region = us-east-1

[profile your-dev-profile]
sso_session = your-org
sso_account_id = YOUR_ACCOUNT_ID
sso_role_name = AdministratorAccess
region = us-east-1
```

Then authenticate:

```bash
aws sso login --profile your-dev-profile
```

### 5. Set Required Secrets

```bash
# Set your AWS profile
export AWS_PROFILE=your-dev-profile

# Set MongoDB connection
pnpm sst secret set MONGODB_URI "mongodb+srv://..." --stage dev

# Set authentication secrets
pnpm sst secret set SESSION_SECRET "$(openssl rand -base64 48)" --stage dev
pnpm sst secret set JWT_SECRET "$(openssl rand -base64 48)" --stage dev
pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage dev
```

See [Secrets Reference](/deployment/secrets-reference) for all available secrets.

### 6. Start the Development Server

```bash
export AWS_PROFILE=your-dev-profile
pnpm sst dev --stage dev
```

Once all services are running, open [http://localhost:3000](http://localhost:3000) in your browser.

## Verify Your Setup

Double-check your local tooling before starting: `node -v` (20.x), `pnpm -v` (9.x+), `aws --version` (2.x), and `aws sts get-caller-identity` to confirm your AWS profile works.

## Core Concepts

### AI Agents
Autonomous AI entities that can perform complex tasks by breaking them down into manageable steps.

### Quest System
Advanced task planning system that helps agents understand and execute multi-step workflows.

### Knowledge Engine
RAG-powered system that allows AI agents to access and reason about your documents and data.

### Artifacts
Reusable components, code snippets, documents, and visualizations created by AI agents.

## Your First Agent

Once you have Bike4Mind running:

1. **Navigate to the Agents section**
2. **Click "Create New Agent"**
3. **Choose a template** (e.g., "Research Assistant")
4. **Configure the agent's capabilities**
5. **Start your first conversation**

## Next Steps

Now that you have Bike4Mind running, explore these areas:

- **[Features Overview](/features)** - Discover all capabilities
- **[Agent Documentation](/agents)** - Deep dive into AI agents
- **[Deployment Guide](/deployment)** - Full deployment documentation

## Need Help?

- **Documentation**: You're already here!
- **[Troubleshooting](/deployment/troubleshooting)** - Common issues and solutions
- **GitHub Issues**: Report bugs on the repository

---

**Ready to enhance your productivity with AI?** Explore the [Features Overview](/features) to see what's possible!
