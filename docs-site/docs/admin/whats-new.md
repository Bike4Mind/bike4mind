---
title: "What's New Modals"
description: Admin tab for managing What's New feature announcements, sync configuration, import from production, and weekly highlights
sidebar_position: 23
tags: [admin, announcements, whats-new]
---

# What's New Modals

The What's New tab in the admin panel manages feature announcement modals that notify users about new capabilities and updates. These modals can be created manually, auto-generated from production deployments, or synced from a source environment. The tab also includes configuration for weekly highlights posted to Slack.

## Environment Awareness

The tab detects the current environment and adjusts its behavior accordingly:

| Environment Type | Chip Color | Behavior |
|-----------------|------------|----------|
| **Source (Main Production)** | Red | Sync is disabled. Modals are auto-generated here and distributed to other environments. The Create button is hidden. |
| **Fork Production** | Orange | Auto-sync defaults to off (opt-in). An info alert explains the fork behavior. |
| **Dev / Staging** | Green | Full sync and create capabilities available. |

## Sync Configuration

The Sync Configuration card is visible on all non-source environments and provides:

### Distribution URL

A URL pointing to the CloudFront, S3, or bike4mind.com endpoint where the production manifest is published. This can be set in two ways:

| Source | Description |
|--------|-------------|
| **SST Secret** | The `WHATS_NEW_DISTRIBUTION_URL` SST secret (default) |
| **Admin Override** | A URL entered in the admin panel, which takes precedence over the SST secret |

The URL is validated client-side to ensure it uses HTTPS and belongs to an allowed domain (CloudFront, S3, or bike4mind.com). The current source (admin override or SST secret) is displayed below the input.

### Auto-Sync Toggle

When enabled, a daily cron job automatically imports the latest modal from the production distribution URL. The toggle is disabled when no distribution URL is configured.

### Manual Sync

The "Sync Latest" button triggers an immediate sync of the latest modal from the distribution URL. A refresh button reloads the sync configuration. The last sync timestamp and result are shown below the controls.

## Active Modals

The Active Modals section displays all local What's New modals, partitioned into two groups:

### Active vs. Archived

Modals are automatically classified based on their state:

| Classification | Criteria |
|---------------|----------|
| **Active** | Enabled AND (no end date OR end date is in the future) |
| **Archived** | Disabled OR end date has passed |

Active modals are shown in the main table. Archived modals are in a collapsible accordion section below.

### Modal Table Columns

Both the Active and Archived tables share the same structure:

| Column | Description |
|--------|-------------|
| **Title** | The modal title (truncated with ellipsis) |
| **Date** | Creation date in ISO format |
| **Status** | Chip showing Active, Disabled, Expired, or Expiring Soon with color coding |
| **Expiry** | Days remaining until expiry, with color coding (green for more than 7 days, warning for 7 days or fewer, danger for expired, neutral for no expiry) |
| **Source** | Where the modal originated (e.g., "production", "self") |
| **Actions** | View, Edit, Enable/Disable toggle, and Delete buttons |

### Creating a Modal

Click "Create Modal" to open a dialog with the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| **Title** | Yes | The announcement heading (e.g., "New Feature: Dark Mode") |
| **Subtitle** | No | Supporting text below the title |
| **Description** | Yes | Full announcement body (Markdown supported) |
| **Expiry Date** | No | Defaults to 30 days from creation. Maximum 2 years in the future. |

### Editing a Modal

Click the Edit icon on any row to open the edit dialog, pre-populated with the current values. The same fields are available as in the create dialog.

### Previewing a Modal

Click the View icon to open a preview dialog showing the title, subtitle, full description, enabled status, source, generated date, and expiry information.

### Deleting a Modal

Click the Delete icon to open a confirmation dialog. This action is permanent and cannot be undone.

### Toggling a Modal

Click the power icon to enable or disable a modal. Disabled modals move to the Archived section.

### Pagination

Both the Active and Archived sections support pagination with configurable items per page. Pagination controls appear when the number of modals exceeds the selected page size.

## Available for Sync

This section appears only on non-source environments when a distribution URL is configured. It shows modals published by the source environment that can be imported.

| Column | Description |
|--------|-------------|
| **Checkbox** | Select individual modals for batch import. A header checkbox selects/deselects all available modals. |
| **Title** | The modal title |
| **Date** | The generated date from the source environment |
| **Status** | "Available" (can be imported) or "Imported" (already synced) |
| **Actions** | Import button for individual modals |

Batch operations:

| Button | Description |
|--------|-------------|
| **Import Selected (N)** | Import only the checked modals |
| **Import All (N)** | Import all available (non-imported) modals |

## Weekly Highlights to Slack

This card is visible on main environments (production, dev, PR previews) but not on fork environments. It configures automatic generation of weekly highlight summaries from What's New modals, posted to a Slack channel.

### Configuration

The configuration is in a collapsible accordion with the following settings:

| Setting | Description |
|---------|-------------|
| **Enabled Toggle** | Turn weekly auto-generation on or off |
| **Slack Channel ID** | The Slack channel (starts with C) where highlights are posted |
| **Slack Team ID** | The Slack workspace/team ID (starts with T) |
| **Attach Markdown File** | When enabled, a `.md` file is attached to the Slack message |
| **Model** | The LLM model used for generating the summary (grouped by provider) |
| **Custom Prompt Template** | Optional template with variable substitution for customizing the generation prompt |

### Template Variables

The prompt template supports variables that are substituted at generation time. Each variable can be copied to the clipboard by clicking its chip. A "View Default Template" button shows the built-in template, which can be copied and customized.

### Actions

| Button | Description |
|--------|-------------|
| **Generate Now** | Trigger an immediate highlights generation (requires Slack channel and team ID) |
| **Save** | Save configuration changes (only active when there are unsaved changes) |

### Last Run Status

An alert shows the result of the most recent generation:

| Status | Color | Description |
|--------|-------|-------------|
| **Success** | Green | Highlights were generated and posted |
| **Failed** | Red | Generation encountered an error |
| **No modals found** | Yellow | No modals were available for the period |
| **Never run** | Neutral | Highlights have not been generated yet |

A "Preview" button on the success alert opens the last generated highlights text.

## Best Practices

- On non-source environments, configure the distribution URL before enabling auto-sync to ensure modals can be fetched.
- Use the expiry date to automatically archive announcements after they become stale, rather than manually disabling them.
- When configuring Weekly Highlights, test with "Generate Now" before enabling the automatic schedule to verify the Slack integration works correctly.
- Keep announcement descriptions concise and use Markdown formatting for readability.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [Modals Management](./modals.md) - Managing general modals and banners
