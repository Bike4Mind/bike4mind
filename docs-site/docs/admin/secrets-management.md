---
title: Secrets Management
description: Admin tabs for managing secret rotation schedules and configuring system secrets with GUI overrides
sidebar_position: 24
tags: [admin, secrets, security, rotation]
---

# Secrets Management

Bike4Mind provides two admin tabs for managing secrets: **Secrets Rotation** for tracking rotation schedules and **System Secrets** for viewing and configuring secret values. Together they give administrators visibility into the state of all platform secrets and the ability to manage them without direct infrastructure access.

## Secrets Rotation

The Secrets Rotation tab tracks the lifecycle of secrets that require periodic rotation. It displays a table of all registered secrets with their rotation status, schedules, and renewal history.

### Rotation Table

| Column | Description |
|--------|-------------|
| **Secret Key Name** | The identifier for the secret (word-break enabled for long names) |
| **Description** | Human-readable description of what the secret is used for |
| **Last Rotation** | The date the secret was last rotated, with a relative time indicator (e.g., "3 days ago") |
| **Next Rotation** | The scheduled next rotation date, with a relative time indicator. Overdue dates display in danger color. |
| **Interval (days)** | The configured rotation interval in days |
| **Status** | Color-coded chip: green for active, red for inactive, yellow when overdue |
| **Last Renewed By** | The name of the administrator who last renewed the secret |
| **Actions** | Renew and Edit buttons |

### Status Color Coding

The status chip color is determined by the combination of active state and next rotation date:

| Condition | Color |
|-----------|-------|
| Inactive | Danger (red) |
| Active but past next rotation date | Warning (yellow) |
| Active and before next rotation date | Success (green) |

### Renewing a Secret

Click the "Renew" button on any row to open a confirmation dialog. Confirming the renewal marks the secret as renewed, resetting its rotation cycle. The renewal is recorded with the current administrator's identity.

### Editing a Secret

Click the "Edit" button to open an edit dialog with the following fields:

| Field | Description |
|-------|-------------|
| **Description** | Update the human-readable description |
| **Previous Key** | Record the previous key value for reference |
| **Rotation Interval (days)** | Set the interval between rotations (1 to 365 days) |

### Auto-Refresh

The rotation data automatically refreshes every 5 minutes to keep the displayed status current. A manual refresh button is also available in the header.

## System Secrets

The System Secrets tab provides a comprehensive view of all configurable platform secrets, organized by category. It supports a two-tier secret architecture where values can come from SST (infrastructure) or be overridden via the admin GUI.

### Infrastructure Secrets (Tier 1)

The top section displays read-only infrastructure secrets that must be configured via the SST CLI. These cannot be edited through the admin panel.

Each secret shows a status chip:

| Status | Color | Icon | Description |
|--------|-------|------|-------------|
| **Configured** | Green | Check circle | Secret is properly set |
| **Warning** | Yellow | Warning triangle | Secret has a potential issue |
| **Placeholder** | Yellow | Warning triangle | Secret contains a placeholder value |
| **Invalid** | Red | Error | Secret value is invalid |
| **Insecure** | Red | Error | Secret value does not meet security requirements |
| **Missing** | Red | Error | Secret is not configured |

Hovering over a status chip shows additional context including a message and hint when available. The current SST stage is displayed at the bottom of this section.

### Configurable Secrets (Tier 2/3)

Below the infrastructure section, configurable secrets are grouped by category:

| Category | Label |
|----------|-------|
| `auth` | Authentication |
| `mail` | Email Configuration |
| `oauth` | OAuth Providers |
| `api_key` | API Keys |
| `slack` | Slack Integration |

Each category is displayed in its own card with a table containing:

| Column | Description |
|--------|-------------|
| **Secret** | The secret name in monospace font, with a warning chip if there are warnings |
| **Description** | What the secret is used for |
| **Status** | Source chip indicating the current value source |
| **Value** | Masked value (e.g., `sk-****1234`) or dash if not set |
| **Actions** | Edit button, plus Delete button if a database override exists |

### Source Status Chips

| Chip | Color | Meaning |
|------|-------|---------|
| **GUI Override** | Green | Value is set via the admin panel (database) |
| **SST** | Primary (blue) | Value comes from the SST secret |
| **Not Configured** | Danger (red) | No value is set in either source |

### Editing a Secret

Click the Edit icon to open the edit dialog:

1. The dialog shows the secret name, description, and current source information.
2. Enter the new value in the password input field. Toggle visibility with the eye icon.
3. Click Save to encrypt and store the value. The secret takes effect immediately.

Values are encrypted before storage in the database.

### Deleting a GUI Override

When a secret has a database override (shown as "GUI Override"), a Delete button appears in the Actions column. Clicking it prompts for confirmation, warning that the secret will revert to using the SST value (if configured). This is useful for rolling back an admin-set value.

## Best Practices

- Monitor the Secrets Rotation tab regularly to identify secrets approaching their rotation deadline. Overdue rotations are highlighted in yellow.
- Use the System Secrets GUI override capability for quick configuration changes, but ensure critical secrets are also properly set in SST for disaster recovery.
- When editing system secrets, use the visibility toggle to verify the entered value before saving.
- Delete GUI overrides when they are no longer needed to keep the secret source clean and traceable.
- The 5-minute auto-refresh on the Secrets Rotation tab ensures the display stays current, but use the manual refresh button after making changes to see immediate updates.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [Identity Providers](./identity-providers.md) - Configuring SSO identity providers
