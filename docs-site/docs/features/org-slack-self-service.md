---
title: Organization Slack Integration
description: How organization owners can connect their Slack workspace to Bike4Mind
sidebar_position: 11
tags: [slack, organization, integration]
---

# Organization Slack Integration

Organization owners can connect their team's Slack workspace directly from the organization settings page. Once connected, all team members can link their personal Slack accounts and receive notifications through Slack.

## Connecting Your Workspace

### Prerequisites

- You must be the **organization owner** (or a system admin)
- Your team must have an active Slack workspace

### Step 1: Open Integrations

1. Go to **Teams** in the sidebar
2. Click your organization
3. Click the **Integrations** tab

### Step 2: Connect Slack

1. Click **Connect Slack Workspace**
2. You'll be redirected to Slack's authorization page
3. Select your workspace and click **Allow**
4. You'll be redirected back to the Integrations tab with a success confirmation

Once connected, the card shows your workspace name, install date, and a "Connected" status badge.

## Disconnecting Your Workspace

1. Go to your organization's **Integrations** tab
2. Click **Disconnect**
3. Confirm the action in the modal

After disconnecting, team members will no longer receive Slack notifications from this organization. Personal Slack account links are preserved but will become inactive until a workspace is reconnected.

## Linking Personal Slack Accounts

After the organization's workspace is connected, each team member can link their own Slack account:

1. Go to **Settings** (personal settings)
2. Click **Link Slack Account**
3. Authorize with the same Slack workspace that the organization connected

Once linked, the member will receive notifications and can interact with the Bike4Mind bot in Slack.

## Limitations

- Each organization can connect **one Slack workspace**
- Each Slack workspace can only be connected to **one organization**
- Only the organization **owner** can connect or disconnect the workspace (managers and members cannot)

## Troubleshooting

| Error | Meaning |
|-------|---------|
| "Slack authorization was denied" | You clicked Cancel on the Slack consent page. Try again and click Allow. |
| "Authorization expired" | You waited too long on the Slack page. Start the flow again. |
| "This Slack workspace is already connected to another organization" | The workspace is in use by a different org. Disconnect it there first. |
| "Slack integration is not configured" | The system Slack app is not set up. Contact your administrator. |
| "Slack is temporarily unavailable" | Slack's API is down. Try again in a few minutes. |

---

## Related Features

- [Slack Multi-Workspace OAuth](./slack-multi-workspace-oauth.md) - Connect Slack workspaces to Bike4Mind
- [Slack AI Model Configuration](./slack-model-config.md) - Configure AI models per channel and org
- [GitHub Slack Notifications](./github-slack-notifications.md) - Get GitHub notifications in Slack
- [Organizations & Teams](./organizations-teams.md) - Manage your organization
