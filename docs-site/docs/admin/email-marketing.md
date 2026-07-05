---
title: Email Marketing
description: Create email templates and manage marketing campaigns with recipient targeting, scheduling, and delivery tracking
sidebar_position: 9
tags: [admin, email, marketing, campaigns]
---

# Email Marketing

The Email Marketing tab provides a complete system for creating email templates and managing outbound email campaigns. It is organized into two sub-tabs: **Templates** for designing reusable email content, and **Campaigns** for configuring, sending, and monitoring email deliveries.

## Email Templates

### Template List

The Templates sub-tab displays all email templates in a table with the following columns:

| Column | Description |
|--------|-------------|
| **Name** | Template name and its auto-generated slug identifier. |
| **Category** | The template category (Marketing, Product Update, Newsletter, Announcement, or Transactional). |
| **Subject** | The email subject line configured for the template. |
| **Status** | Active or Inactive status chip. |
| **Actions** | Edit, Clone, and Delete buttons. |

Templates that are referenced by existing campaigns cannot be deleted. A lock icon with a tooltip is shown instead of the delete button, indicating which campaigns are using the template.

### Template Editor

The template editor provides a split-panel interface with a form on the left and a live preview on the right. The divider between panels is resizable by dragging.

#### Template Fields

| Field | Required | Description |
|-------|----------|-------------|
| **Template Name** | Yes | The display name. A URL-friendly slug is auto-generated from the name. |
| **Description** | No | Brief description of the template's purpose. |
| **Category** | Yes | One of: Marketing, Product Update, Newsletter, Announcement, Transactional. |
| **Status** | Yes | Active or Inactive. Only active templates are available for campaign selection. |
| **Subject Line** | Yes | The email subject. Supports template variables. |
| **HTML Content** | Yes | The full HTML email body. Supports template variables. |
| **Plain Text Content** | No | A fallback plain-text version for email clients that do not support HTML. |

#### Available Template Variables

Variables can be inserted into both the subject line and HTML content. Click any variable chip in the editor to copy it to your clipboard.

| Variable | Description |
|----------|-------------|
| `{{userName}}` | Recipient's full name |
| `{{userFirstName}}` | Recipient's first name |
| `{{userEmail}}` | Recipient's email address |
| `{{appName}}` | Application name (Bike4Mind) |
| `{{date}}` | Current date |
| `{{unsubscribeUrl}}` | Unsubscribe link (required for marketing emails) |

#### What's New Content

When the template category is set to "Product Update", a special What's New section appears that automatically fetches the latest product update content. The HTML from the most recent What's New modal can be copied and pasted into the template body.

#### Test Emails

For saved templates, a **Test Email** button allows sending a preview to a specified email address to verify rendering before using the template in a campaign.

### Template Operations

| Operation | Description |
|-----------|-------------|
| **Create** | Opens the editor in create mode with default values. |
| **Edit** | Opens the editor with the selected template's data pre-populated. |
| **Clone** | Creates a copy of the template and opens it in the editor for modifications. |
| **Delete** | Removes the template after confirmation. Only available for templates not used by any campaign. |

## Email Campaigns

### Campaign List

The Campaigns sub-tab shows all campaigns in a table with the following columns:

| Column | Description |
|--------|-------------|
| **Name** | Campaign name, creation date, and a "TEST" badge if the campaign is in test mode. |
| **Recipients** | The recipient targeting type (All Users, All Subscribers, Users & Subscribers, Specific, or test count). |
| **Status** | The overall campaign status: Draft, Sending, Complete, Partial, or Cancelled. Includes the last sent date and scheduled time if applicable. |
| **Progress** | A progress bar showing sent/total count with failure count if any. |
| **Open Rate** | Percentage of sent emails that have been opened. |
| **Actions** | Edit, Cancel (for scheduled or in-progress campaigns), and Clone buttons. |

### Campaign Filters

Toggle the **Filters** button to reveal filtering controls:

| Filter | Description |
|--------|-------------|
| **Exclude test campaigns** | Hides campaigns that were run in test mode. |
| **From Date** | Only show campaigns created on or after this date. |
| **To Date** | Only show campaigns created on or before this date. |
| **Clear Filters** | Resets all filter selections. |

### Campaign Detail Editor

The campaign detail view is a split-panel layout with configuration on the left and email preview on the right. Configuration is organized into collapsible accordion sections.

#### Campaign Details Section

| Field | Required | Description |
|-------|----------|-------------|
| **Campaign Name** | Yes | A descriptive name for the campaign. |
| **Template** | Yes | Select from active email templates. Only active templates appear in the dropdown. |
| **Subject Override** | No | Optionally override the template's subject line for this specific campaign. |

#### Recipients Section

Select the target audience for the campaign:

| Recipient Type | Description |
|----------------|-------------|
| **All Users** | All registered users with email addresses. |
| **All Subscribers** | Newsletter subscribers (may not have accounts). |
| **All Users & Subscribers** | Both groups, deduplicated by email. |
| **Specific Emails** | Manually entered email addresses, one per line or comma-separated. |

After selecting a recipient type, a preview panel displays the total, eligible, and excluded recipient counts. An inline table shows the first several recipients, with a "View All" button to open a full paginated modal with search capabilities.

#### Test Mode Section

| Setting | Description |
|---------|-------------|
| **Enable Test Mode** | When enabled, emails are composed for actual recipients (to preview personalization) but delivered to the specified test addresses instead. Subject lines are prefixed with `[TEST]`. |
| **Test Email Addresses** | One or more test email addresses, separated by newlines or commas. |

#### Send Campaign Section

| Action | Description |
|--------|-------------|
| **Send Campaign / Send Test** | Sends the campaign immediately. Auto-saves any unsaved changes before sending. For new campaigns, creates and sends in one step. |
| **Schedule** | (Edit mode only) Sets a future date and time for automatic delivery. |
| **Cancel Schedule** | Cancels a previously scheduled send. |
| **Cancel All Pending** | When a campaign is actively sending, cancels all remaining unsent emails. |

#### Email Preview

The right panel shows a live preview of the email as it will appear to recipients. Features include:

- **Recipient selector** to preview the email with different recipients' personalized data.
- **Subject preview** with variable replacement.
- **HTML body preview** rendered in an iframe.
- **Fullscreen preview** button for a larger view.

#### Status Summary and Activity History

For existing campaigns, the bottom of the detail view includes:

- **Email Status Summary** showing delivery statistics.
- **Email Activity History** listing individual email attempts with status, timestamps, and the ability to view the rendered email for each attempt.

## Best Practices

- Always send a test email before launching a campaign to verify variable replacement and formatting.
- Use the "Product Update" category with the What's New content integration to keep product update emails consistent with in-app announcements.
- Monitor the open rate column on the campaigns list to track engagement over time.
- Use the clone feature to iterate on successful campaigns rather than starting from scratch.
- For large campaigns, use the recipient preview to verify the correct audience before sending.

## Related Articles

- [Subscribers](./subscribers.md)
- [Invite Codes](./invite-codes.md)
