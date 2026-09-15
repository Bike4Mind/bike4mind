---
title: GitHub Webhooks
description: Configure real-time GitHub event notifications with webhook subscriptions, delivery tracking, and circuit breakers
sidebar_position: 2
tags: [github, webhooks, notifications, events]
---

# GitHub Webhooks

Receive real-time notifications when events happen in your GitHub repositories — issues created, PRs merged, workflows completed, and more. Webhook events are routed to Slack channels or DMs based on your subscription preferences.

## Overview

The GitHub webhook system provides:

- **Organization-level webhook configuration** with encrypted secrets
- **Per-user subscriptions** with event and repository filtering
- **Delivery tracking** with retry capability
- **Circuit breaker** that auto-disables failing subscriptions
- **Secret rotation** with 24-hour dual-acceptance window

## Getting Started

### Step 1: Create a Webhook Configuration (Admin)

Organization admins create a webhook config that generates a unique URL for GitHub:

1. Navigate to **Organization → Settings → Webhooks**
2. Click **Create GitHub Webhook**
3. Configure:
   - **Repositories** to monitor (or all repos)
   - **Events** to receive (see [Supported Events](#supported-events))
4. Copy the generated **Webhook URL** and **Secret**

:::danger Save Your Secret
The webhook secret is shown **only once** at creation time. Store it securely — you'll need it when configuring the webhook in GitHub. If lost, you must rotate the secret.
:::

### Step 2: Configure in GitHub

1. Go to your GitHub organization **Settings → Webhooks → Add webhook**
2. Set:
   - **Payload URL**: The webhook URL from Step 1
   - **Content type**: `application/json`
   - **Secret**: The webhook secret from Step 1
3. Select the events you want to receive
4. Click **Add webhook**

### Step 3: Subscribe to Events (Users)

Individual team members subscribe to receive specific events:

1. Navigate to **Organization → Settings → Webhooks → Subscriptions**
2. Click **Add Subscription**
3. Choose:
   - **Events** you want to receive
   - **Delivery target**: Slack channel or DM
   - **Filters**: Specific repositories, branches, or authors
4. Save your subscription

## Webhook Configuration API

Organization admins manage webhook configs through these endpoints:

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/organizations/{id}/webhooks/github` | Create webhook config |
| `GET` | `/api/organizations/{id}/webhooks/github` | Get config (secret masked) |
| `PUT` | `/api/organizations/{id}/webhooks/github` | Update config |
| `DELETE` | `/api/organizations/{id}/webhooks/github` | Delete config and all subscriptions |
| `POST` | `/api/organizations/{id}/webhooks/github/rotate-secret` | Rotate webhook secret |
| `POST` | `/api/organizations/{id}/webhooks/github/test` | Send test webhook |

## Supported Events

| Event | Description |
|---|---|
| `push` | Code pushed to a branch |
| `pull_request` | PR opened, closed, merged, or updated |
| `pull_request_review` | PR review submitted |
| `issues` | Issue opened, closed, or updated |
| `issue_comment` | Comment on an issue or PR |
| `create` | Branch or tag created |
| `delete` | Branch or tag deleted |
| `workflow_run` | GitHub Actions workflow completed |
| `release` | Release published |
| `star` | Repository starred |

## Subscription Management

### Creating Subscriptions

Subscriptions define who receives which events and where:

| Field | Description |
|---|---|
| **Events** | Which events to receive (e.g., `pull_request`, `issues`) |
| **Target type** | `channel` (Slack channel) or `dm` (direct message) |
| **Target** | Slack channel ID or user's linked Slack account |
| **Filters** | Optional repo, branch, or author filters |

### Subscription API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/webhooks/github/subscriptions` | List your subscriptions |
| `POST` | `/api/webhooks/github/subscriptions` | Create a subscription |
| `PUT` | `/api/webhooks/github/subscriptions/{id}` | Update a subscription |
| `DELETE` | `/api/webhooks/github/subscriptions/{id}` | Delete a subscription |

:::info Subscription Limits
Each organization can have up to **500 active subscriptions**. If you're approaching this limit, consider consolidating subscriptions by using broader event filters.
:::

## Delivery Tracking

Every webhook delivery is recorded with status and metadata:

| Field | Description |
|---|---|
| **Status** | `Success`, `Filtered`, or `Failed` |
| **Correlation ID** | Unique ID for tracing delivery across systems |
| **Processing time** | Duration from receipt to delivery |
| **Payload** | Sanitized payload stored for failed deliveries |

### Delivery API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/webhooks/deliveries` | List recent deliveries |
| `POST` | `/api/webhooks/deliveries/{id}/retry` | Retry a failed delivery |

### Retrying Failed Deliveries

Failed deliveries can be retried manually:

1. Navigate to **Organization → Settings → Webhooks → Deliveries**
2. Find the failed delivery
3. Click **Retry**

Or via API: `POST /api/webhooks/deliveries/{id}/retry`

## Security

### Signature Verification

Every incoming webhook is verified using HMAC-SHA256:

1. GitHub signs each payload with your webhook secret
2. The signature is sent in the `X-Hub-Signature-256` header
3. Bike4Mind recomputes the signature and compares using timing-safe comparison
4. Invalid signatures are rejected with `401 Unauthorized`

:::warning Timing-Safe Comparison
Signature verification uses constant-time comparison to prevent timing attacks. Never implement your own signature verification without this protection.
:::

### Secret Encryption

- Webhook secrets are encrypted at rest using **AES-256-GCM**
- Secrets are only decrypted in memory during signature verification
- The `SECRET_ENCRYPTION_KEY` is stored as an environment variable, never in the database

### Secret Rotation

To rotate a webhook secret without downtime:

1. Call `POST /api/organizations/{id}/webhooks/github/rotate-secret`
2. A new secret is generated and returned (one-time display)
3. Both old and new secrets are accepted for **24 hours**
4. Update the secret in your GitHub webhook settings
5. After 24 hours, only the new secret is accepted

## Circuit Breaker

The circuit breaker protects against persistent delivery failures:

| Threshold | Behavior |
|---|---|
| **5 consecutive failures** | Subscription is automatically disabled |
| **Auto-disable** | No further deliveries attempted until re-enabled |
| **Re-enable** | User manually re-enables in subscription settings |

:::tip Monitoring Circuit Breaker
Check your subscription status regularly. If a subscription is auto-disabled, investigate the delivery failures before re-enabling. Common causes: Slack channel deleted, bot removed from channel, or Slack rate limiting.
:::

## Rate Limits

| Limit | Value | Scope |
|---|---|---|
| Incoming webhooks | No Bike4Mind-imposed limit | Per webhook config |
| Outgoing Slack messages | Subject to Slack API rate limits | Per workspace |
| Delivery retries | 1 retry per delivery | Per delivery |

:::info GitHub's Webhook Limits
GitHub has its own limits on webhook deliveries. If GitHub can't reach your webhook URL, it will retry with exponential backoff for up to 3 days. See [GitHub's webhook documentation](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
:::

## Known Limitations

- **Repository-level webhooks** are not supported — only organization-level
- **Webhook replays** are limited to the last 30 days of deliveries
- **Payload size** is capped at 1 MB — larger payloads are rejected with `413`
- **Event filtering** applies at the subscription level, not the webhook level — all events configured in GitHub are received, then filtered per subscription
- **Slack delivery only** — webhook events can currently only be delivered to Slack channels or DMs (no email, no other services)

## Troubleshooting

For common webhook issues, see the [Troubleshooting Guide](./troubleshooting.md#webhooks).

**Quick fixes:**

- **"Invalid signature"** → Ensure the secret in GitHub matches the one shown in Bike4Mind
- **"Subscription auto-disabled"** → Check that the Slack channel still exists and the bot is a member
- **"No deliveries received"** → Verify the webhook URL is correct in GitHub settings and the webhook is active

## Related Documentation

- [GitHub Integration](./github-integration.md) — Connect your GitHub account
- [GitHub MCP Tools Reference](./github-mcp-tools.md) — All 46 GitHub tools
- [GitHub Slack Notifications](../github-slack-notifications.md) — Slack DM delivery for GitHub events
- [Troubleshooting](./troubleshooting.md) — Cross-integration troubleshooting guide
