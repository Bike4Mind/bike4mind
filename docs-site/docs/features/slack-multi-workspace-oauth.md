---
title: Slack Multi-Workspace OAuth
description: How to connect multiple Slack workspaces to Bike4Mind
sidebar_position: 10
tags: [slack, oauth, integration, admin]
---

# Slack Multi-Workspace OAuth

Bike4Mind supports connecting multiple Slack workspaces through OAuth. Each workspace gets its own bot token, allowing the Bike4Mind bot to respond to messages in any connected workspace.

## For Workspace Admins: Installing the Bot

### Step 1: Start the Installation

1. Navigate to `/integrations/slack/install` in your Bike4Mind instance
2. Click **"Add to Slack"**

### Step 2: Authorize in Slack

1. You'll be redirected to Slack's authorization page
2. Select the workspace you want to connect
3. Review the permissions requested
4. Click **"Allow"**

### Step 3: Installation Complete

After authorization, you'll be redirected to a success page confirming the installation. The bot is now ready to use in your workspace.

## Using the Bot

Once installed, you need to invite the bot to channels where you want to use it.

### Step 1: Invite the Bot to a Channel

Before the bot can respond in a channel, you must invite it:

1. Open the channel where you want to use the bot
2. Type `/invite @Bike4Mind Bot` and press Enter

The bot will now be able to see and respond to messages in that channel.

### Step 2: Interact with the Bot

Once invited, mention the bot to start chatting:

```
@Bike4Mind Bot hello
```

Type `@agent help` to see all available commands and capabilities.

### Direct Messages

You can also DM the bot directly without inviting it to any channel - just find "Bike4Mind Bot" in your DM list and send a message.

## For Admins: Managing Workspaces

### Viewing Connected Workspaces

1. Go to **Admin** → **Slack Workspaces** tab
2. View all connected workspaces with:
   - Workspace name
   - Team ID
   - Bot name
   - Installation date
   - Status (Active/Inactive)

### Deactivating a Workspace

If you need to disconnect a workspace:

1. Go to **Admin** → **Slack Workspaces**
2. Find the workspace in the table
3. Click the **trash icon** in the Actions column
4. Confirm deactivation

Once deactivated:
- The bot will stop responding to messages from that workspace
- The workspace can be reconnected by reinstalling via OAuth

### Reactivating a Workspace

To reconnect a previously deactivated workspace:

1. Have a workspace admin go to `/integrations/slack/install`
2. Complete the OAuth flow again
3. The workspace will be reactivated with a fresh token

## Troubleshooting

### Bot Not Responding

1. **Check workspace status**: Go to Admin → Slack Workspaces and verify the workspace is "Active"
2. **Verify bot is in channel**: The bot must be invited to channels to receive messages
3. **Check for mentions**: In channels, the bot only responds to direct mentions or agent commands

### "Workspace not connected" Error

This means the workspace hasn't been installed via OAuth. Have a workspace admin complete the installation at `/integrations/slack/install`.

### Reinstallation Required

If the bot token becomes invalid (e.g., permissions changed, app reinstalled in Slack), you may need to:

1. Deactivate the workspace in Admin → Slack Workspaces
2. Reinstall via OAuth at `/integrations/slack/install`

## Security Notes

- Each workspace has its own isolated bot token
- Tokens are stored securely and excluded from normal database queries
- Deactivating a workspace immediately revokes bot access
- OAuth flow includes CSRF protection via signed state tokens

---

## Related Features

- [Organization Slack Integration](./org-slack-self-service.md) - Org-level Slack workspace setup
- [Slack AI Model Configuration](./slack-model-config.md) - Configure AI models per channel and org
- [GitHub Slack Notifications](./github-slack-notifications.md) - Get GitHub notifications in Slack
- [Organizations & Teams](./organizations-teams.md) - Manage your organization
