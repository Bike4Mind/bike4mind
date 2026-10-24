---
title: "What's New Modals"
description: Admin tab for managing What's New feature announcement modals and weekly highlights
sidebar_position: 23
tags: [admin, announcements, whats-new]
---

# What's New Modals

The What's New tab in the admin panel manages feature announcement modals that notify users about new capabilities and updates. You author these modals by hand; release notes generated from each production release are managed in the Release notes tab. The tab also includes configuration for weekly highlights posted to Slack.

## Upstream Release Notes Feed

Set the `WHATS_NEW_FEED_URL` environment variable to the https URL of another deployment's `GET /api/v1/whats-new` to serve its release notes in the What's New slider. They are served ahead of local release notes, and the slider falls back to local release notes when the upstream feed fails.

The URL may instead point at a [JSON Feed](https://jsonfeed.org) document, such as the `whats-new.json` a marketing site publishes for its own What's New page. Each item becomes one slide: its title, its `content_text` (or `summary` when text is blank), its first tag as the label and its `date_published` as the date. Items without a date are skipped, and entries are cursor-paginated newest first. A JSON Feed may live on this deployment's own domain; this deployment's own `/api/v1/whats-new` route is refused both directly and as a redirect target, since fetching it would recurse.

An upstream note's video or still image is served from the upstream deployment's own media route (`/api/v1/whats-new/media/...`), so setting `WHATS_NEW_FEED_URL` also adds its origin to the `img-src`, `connect-src` and `media-src` Content Security Policy directives. An upstream video or image with any URL outside that origin or this deployment's media allowlist is dropped (each on its own) and the slide shows without it.

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
| **Date** | Creation date in ISO format; modals left over from the retired generator show the date they were generated |
| **Status** | Chip showing Active, Disabled, Expired, or Expiring Soon with color coding |
| **Expiry** | Days remaining until expiry, with color coding (green for more than 7 days, warning for 7 days or fewer, danger for expired, neutral for no expiry) |
| **Source** | Where the modal originated: `self` for modals authored on this deployment, `production` only on modals left over from a retired production import |
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

## Weekly Highlights to Slack

This card is visible on main environments (production, dev, PR previews) but not on fork environments. It configures on-demand generation of weekly highlight summaries from What's New modals, posted to a Slack channel. There is no automatic schedule: highlights are generated only when an admin clicks **Generate Now**.

### Configuration

The configuration is in a collapsible accordion with the following settings:

| Setting | Description |
|---------|-------------|
| **Enabled Toggle** | Saved with the config but currently has no effect, since there is no automatic schedule |
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

- Use the expiry date to automatically archive announcements after they become stale, rather than manually disabling them.
- When configuring Weekly Highlights, use a test Slack channel for the first "Generate Now" run to verify the Slack integration works correctly.
- Keep announcement descriptions concise and use Markdown formatting for readability.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [Modals Management](./modals.md) - Managing general modals and banners
