---
title: Slack Admin Guide
description: Set up and manage the Bike4Mind Slack app for your workspace with manifest-based configuration
sidebar_position: 2
tags: [slack, admin, setup, oauth, workspace]
---

# Slack Admin Guide

This guide covers setting up the Bike4Mind Slack app for your workspace, including app creation, OAuth installation, and workspace management.

**Target Audience:** Slack workspace administrators, IT administrators

## Quick Setup Guide

Follow these four steps to get the Slack integration running:

1. **[Get Slack Config Token](#step-1-get-slack-config-token)** — Generate a temporary token from Slack
2. **[Create Slack App](#step-2-create-slack-app)** — Use Bike4Mind admin panel to create the app
3. **[Install to Workspace](#step-3-install-app-to-workspace)** — Complete OAuth installation
4. **[Invite Bot to Channels](#step-4-invite-bot-to-channels)** — Add bot to desired channels

## Step 1: Get Slack Config Token

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Sign in with a Slack account that has **workspace admin permissions**
3. In the top-right corner, click your workspace name → **Generate Token**
4. Copy the generated token (starts with `xoxp-...`)

:::warning Token Expiration
This configuration token is temporary and expires after a short period. Use it immediately in Step 2.
:::

## Step 2: Create Slack App

Instead of manually configuring a Slack app, Bike4Mind creates it automatically using a manifest:

1. Navigate to **General Ops → Admin Settings → Slack Workspaces**
2. Click **"Create Slack App"**
3. Fill in the form:
   - **App Name**: Your bot name (defaults to branding setting)
   - **Description**: Brief description of the bot
   - **Background Color**: Color for the app icon
   - **Base URL**: Your Bike4Mind application URL (auto-filled)
   - **Slack Config Token**: Paste the token from Step 1
4. Click **"Create Slack App"**

**What happens automatically:**
- Bike4Mind calls Slack's API with a manifest configuration
- The app is created with all required settings:
  - OAuth scopes (bot permissions)
  - Event subscriptions
  - Slash commands (`/b4m`, `/notebook`)
  - Request URLs for events and interactions
- App credentials are saved to the database

### Required Bot Scopes

The manifest configures these scopes automatically:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | View @mentions |
| `channels:history` | Read public channel messages |
| `channels:read` | List public channels |
| `chat:write` | Send messages |
| `commands` | Register slash commands |
| `files:read` | Access shared files |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `im:read` | List DM conversations |
| `im:write` | Send direct messages |
| `mpim:history` | Read group DM messages |
| `reactions:read` | Read reactions |
| `reactions:write` | Add reactions |
| `users:read` | Look up users |
| `users:read.email` | Match users by email |

## Step 3: Install App to Workspace

After the app is created:

1. In Bike4Mind admin panel, click **"Install to Workspace"** next to your new app
2. Slack will show an OAuth consent screen listing all requested permissions
3. Click **"Allow"** to complete the installation
4. Verify the app shows as "Installed" in the admin panel

:::tip Multi-Workspace Support
Bike4Mind supports installing the Slack app to multiple workspaces. See [Multi-Workspace OAuth](../slack-multi-workspace-oauth.md) for details.
:::

## Step 4: Invite Bot to Channels

The bot only responds in channels where it has been invited:

1. In each Slack channel where you want the bot active:
   ```
   /invite @Bike4Mind Bot
   ```
2. The bot will confirm it has joined the channel

:::info Private Channels
For private channels, you must explicitly invite the bot. It cannot discover or join private channels on its own.
:::

## Workspace Management

### Viewing Connected Workspaces

Navigate to **General Ops → Admin Settings → Slack Workspaces** to see:

- All connected workspaces
- Installation status
- Bot user ID
- Team/workspace ID

### Removing a Workspace

To disconnect a workspace:

1. Navigate to **Admin Settings → Slack Workspaces**
2. Click **Remove** next to the workspace
3. Confirm the removal

:::warning Removing a Workspace
Removing a workspace disconnects all users in that workspace from Slack features. Their linked Slack accounts will no longer function until reconnected.
:::

### Updating the App

If you need to update the app configuration (e.g., add new scopes):

1. Update the app manifest in Slack's API dashboard at [https://api.slack.com/apps](https://api.slack.com/apps)
2. Re-authorize the app in any workspaces where scope changes require new consent

## Configuration Storage

Slack app credentials and configuration are stored in:

- **Database**: App ID, client ID, encrypted client secret, bot token, team metadata
- **Environment variables**: Any SST secrets for Slack configuration

:::danger Never Share Bot Tokens
Bot tokens (`xoxb-...`) provide full access to the bot's capabilities. Never share them in public channels, commit them to code, or expose them in logs.
:::

## Permissions and Access

| Role | Capabilities |
|---|---|
| **Organization Admin** | Create/delete Slack apps, manage workspaces, view all subscriptions |
| **Workspace Admin** | Install app to workspace, manage channel invitations |
| **Organization Member** | Link personal Slack account, subscribe to notifications |

## Known Limitations

- **One app per workspace** — each Slack workspace can only have one Bike4Mind app installed
- **Manifest changes** — some changes to the app manifest require re-authorization
- **Event subscriptions** — events are workspace-wide; you cannot selectively receive events from specific channels at the app level
- **Rate limits** — Slack enforces rate limits that may delay responses during high-volume usage

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| "Invalid config token" | Token expired | Generate a new token in Step 1 |
| "App creation failed" | Slack API error or insufficient permissions | Verify admin permissions and retry |
| "OAuth failed" | Authorization denied or token mismatch | Restart from Step 3 |
| "Bot not responding" | Bot token revoked or app uninstalled | Reinstall the app |

## Troubleshooting

For common issues, see the [Troubleshooting Guide](./troubleshooting.md#slack).

**Quick fixes:**

- **App creation fails** → Ensure your config token hasn't expired
- **Bot doesn't respond after install** → Check that the bot is invited to the channel
- **OAuth consent fails** → Verify you have workspace admin permissions

## Related Documentation

- [Slack Integration Guide](./slack-integration.md) — End-user features and agents
- [Slack Commands Reference](./slack-commands.md) — All commands and @mention patterns
- [Organization Slack Integration](../org-slack-self-service.md) — Self-service connection
- [Slack Multi-Workspace OAuth](../slack-multi-workspace-oauth.md) — Multi-workspace setup
- [Slack Model Configuration](../slack-model-config.md) — AI models per channel
