---
title: Slack Workspaces
description: Manage Slack workspace connections, bot installations, channel exports, and app manifest updates from the admin panel
sidebar_position: 26
tags: [admin, slack, integrations, workspaces]
---

# Slack Workspaces

The Slack Workspaces tab provides administrators with a centralized interface for managing all Slack workspaces connected to the platform via OAuth. From this tab you can view connected workspaces, create new Slack apps, install bots, export channel message history, manage app manifests, and deactivate workspaces.

## Workspace Table

The main view displays a table of all connected workspaces. A count chip in the header shows the total number of connected workspaces.

| Column | Description |
|--------|-------------|
| **Workspace** | The workspace name |
| **Team ID** | The Slack team identifier (monospace) |
| **App ID** | The Slack application identifier (monospace) |
| **Bot Name** | The name of the installed bot |
| **Installed** | The date the bot was installed, or a "Not Installed" warning chip |
| **Status** | Active (green) or Inactive (neutral) chip |
| **Manifest** | Current manifest status with actionable indicators |
| **Actions** | Export, Install, and Deactivate action buttons |

When no workspaces are connected, an empty state message explains that workspaces appear after users install the bot via OAuth at `/integrations/slack/install`.

## Creating a Slack App

Click the **Create Slack App** button in the header to open the creation modal. This launches the `CreateSlackAppModal` component which guides you through setting up a new Slack application. After successful creation, the workspace list automatically refreshes.

## Installing a Bot

For workspaces that show "Not Installed" status, an **Install** button appears in the Actions column. Clicking it navigates to `/integrations/slack/install?workspaceId={id}` to initiate the OAuth installation flow.

## Manifest Management

The system automatically checks the manifest status of each workspace on load. Manifest checks run in parallel for all workspaces.

| Manifest Status | Indicator | Action |
|----------------|-----------|--------|
| **Checking** | Spinning progress indicator | Wait for check to complete |
| **Up to date** | Green "Up to date" chip with checkmark | No action needed |
| **Update Available** | Yellow "Update Available" chip | Click the update icon to review and apply changes |
| **Reconnect** | Red "Reconnect" chip | Click to provide a new configuration token |
| **Error** | Neutral "Error" chip with tooltip | Hover for error details |

### Updating a Manifest

When a manifest update is available, clicking the update icon opens a confirmation modal that shows:

- The workspace name being updated
- A scrollable list of specific differences between the current and expected manifest (field name, current value, and new value)
- A note that the update affects scopes, events, commands, and interactivity settings but preserves the app's name, description, and color

### Reconnecting a Configuration Token

When the manifest status shows "Reconnect" (missing token), clicking the reconnect icon opens a modal to provide a Slack app configuration token. The modal includes instructions for generating a token from `api.slack.com/apps`. Configuration tokens expire after 12 hours.

## Channel Message Export

Click the export (download) icon on any active, installed workspace to open the export modal. The export feature supports both synchronous (immediate download) and asynchronous (background processing) modes.

### Export Configuration

| Field | Description |
|-------|-------------|
| **Channel ID** | Required. The Slack channel ID to export (e.g., `C01234ABCDE`). A "Check" button validates the channel before export. |
| **Export Format** | JSON (structured data), CSV (spreadsheet), or Markdown (readable) |
| **Date Range** | Optional date filtering with preset shortcuts and custom date pickers |
| **Include thread replies** | Checkbox to include threaded message replies (enabled by default) |
| **Include user names** | Checkbox to resolve user IDs to display names (enabled by default) |
| **Background Export** | Toggle for asynchronous processing of large channels (up to 15 minutes) |

### Date Range Presets

Quick-select chips are available for common date ranges:

| Preset | Description |
|--------|-------------|
| **Last 7 days** | Previous 7 days through today |
| **Last 30 days** | Previous 30 days through today |
| **This month** | First day of current month through today |
| **Last month** | First through last day of previous month |
| **All time** | No date filtering (clears both start and end) |

A warning is displayed when no date filter is set, advising that exports without date filters may time out on large channels.

### Channel Pre-Validation

After entering a channel ID, click **Check** to validate the channel before exporting. The validation response displays:

- Channel name and visibility (public/private)
- Archived status if applicable
- Estimated message count
- Member count
- Date of the first message

If the channel has more than 10,000 estimated messages and no date filter is set, the system automatically applies the "Last 30 days" preset.

The bot must be a member of the target channel. The modal displays guidance on how to invite the bot using `/invite @BotName` in Slack.

### Synchronous Export

With Background Export disabled, the export downloads immediately as a file. The system handles partial exports gracefully, notifying the user if warnings occurred during export.

### Asynchronous (Background) Export

With Background Export enabled, the export runs in the background with real-time progress tracking:

| Job Status | Description |
|------------|-------------|
| **Pending** | Job is queued and starting |
| **Processing** | Export is in progress with a progress bar and message count |
| **Completed** | Export finished; a download button with file size and expiration time is shown |
| **Failed** | Export failed; error message is displayed |
| **Cancelled** | Export was cancelled by the user |

Progress is polled every 2 seconds. Active background exports can be cancelled. The download link for completed exports has an expiration time (displayed in the UI).

### Export Error Handling

The system provides specific error messages and suggestions for common failure scenarios including gateway timeouts (504), request timeouts (408), payload-too-large errors (413), and CloudFront HTML error pages.

## Deactivating a Workspace

Click the delete icon on any active workspace to open a confirmation modal. Deactivating a workspace stops the bot from responding to messages in that workspace. The workspace can be reconnected later by reinstalling via OAuth. Deactivation events are logged for audit purposes.

## Best Practices

- Always validate a channel with the **Check** button before exporting, especially for large channels.
- Use date range filters for channels with more than 10,000 messages to avoid timeouts.
- Enable **Background Export** for large channels rather than relying on synchronous downloads.
- Keep app manifests up to date by applying updates when the "Update Available" indicator appears.
- Regenerate configuration tokens promptly when the "Reconnect" status appears, as tokens expire after 12 hours.

---

## Related Articles

- [Metrics](./metrics.md) - Slack Metrics analytics
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
