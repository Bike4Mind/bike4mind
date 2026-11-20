---
title: Secrets Management
description: Admin tabs for managing secret rotation schedules and configuring system secrets with GUI overrides
sidebar_position: 24
tags: [admin, secrets, security, rotation]
---

# Secrets Management

Bike4Mind provides two admin tabs for managing secrets: **Secrets rotation** for tracking rotation schedules and **System secrets** for viewing and configuring secret values. Together they give administrators visibility into the state of all platform secrets and the ability to manage them without direct infrastructure access.

## Secrets Rotation

The Secrets rotation tab tracks the lifecycle of secrets that require periodic rotation. It displays a table of all registered secrets with their rotation status, schedules, and renewal history. Each row stays on one line; on a narrow screen the table scrolls sideways inside its own frame.

### Rotation Table

| Column | Description |
|--------|-------------|
| **Secret** | The identifier for the secret. A long name is cut short with an ellipsis; hover it to see the full name. |
| **Description** | Human-readable description of what the secret is used for |
| **Interval (days)** | The configured rotation interval in days |
| **Last renewed** | The date the secret was last renewed. Hover it for the relative time (e.g., "3 days ago"). |
| **Last renewed by** | The name of the administrator who last renewed the secret |
| **Next rotation** | The scheduled next rotation date. Hover it for the relative time. |
| **Status** | Status chip: Active, Overdue, or Inactive |

The row actions (Mark renewed and Edit rotation) are in the "..." menu at the end of each row.

### Status Color Coding

The status chip is determined by the combination of active state and next rotation date:

| Condition | Chip | Color |
|-----------|------|-------|
| Inactive | Inactive | Grey |
| Active but past next rotation date | Overdue | Amber |
| Active and before next rotation date | Active | Green |

### Renewing a Secret

Open the row's "..." menu and choose "Mark renewed" to open a confirmation dialog. Confirming with "Mark renewed" marks the secret as renewed, resetting its rotation cycle. The renewal is recorded with the current administrator's identity.

### Editing a Secret

Open the row's "..." menu and choose "Edit rotation" to open an edit dialog with the following fields, then click "Save changes":

| Field | Description |
|-------|-------------|
| **Description** | Update the human-readable description |
| **Rotation interval (days)** | Set the interval between rotations (1 to 365 days) |

### Auto-Refresh

The rotation data automatically refreshes every 5 minutes to keep the displayed status current. A Refresh button is also available in the page header.

## System Secrets

The System secrets tab provides a comprehensive view of all configurable platform secrets, organized by category. It supports a two-tier secret architecture where values can come from SST (infrastructure) or be overridden via the admin GUI.

### Infrastructure Secrets (Tier 1)

The top section displays read-only infrastructure secrets that must be configured via the SST CLI. These cannot be edited through the admin panel.

Each secret shows a status chip:

| Status | Color | Description |
|--------|-------|-------------|
| **Configured** | Green | Secret is properly set |
| **Warning** | Amber | Secret has a potential issue |
| **Placeholder** | Grey | Secret contains a placeholder value |
| **Invalid** | Red | Secret value is invalid |
| **Insecure** | Red | Secret value does not meet security requirements |
| **Missing** | Red | Secret is not configured |

Hovering over a status chip shows additional context including a message and hint when available. The section description names the current SST stage.

### Configurable Secrets (Tier 2/3)

Below the infrastructure section, configurable secrets are grouped by category:

| Category | Label |
|----------|-------|
| `auth` | Authentication |
| `mail` | Email configuration |
| `oauth` | OAuth providers |
| `api_key` | API keys |
| `slack` | Slack integration |

The secrets are listed in one table, with a header row for each category. The table contains:

| Column | Description |
|--------|-------------|
| **Secret** | The secret name in monospace font, with a Warning chip if there are warnings. Hover the chip to read them. |
| **Description** | What the secret is used for |
| **Source** | Chip indicating the current value source |
| **Value** | Masked value (e.g., `sk-****1234`) or dash if not set |

The row actions are in the "..." menu at the end of each row: "Edit value", plus "Delete override" if a database override exists.

### Source Status Chips

| Chip | Color | Meaning |
|------|-------|---------|
| **GUI override** | Indigo | Value is set via the admin panel (database) |
| **SST** | Grey | Value comes from the SST secret |
| **Not configured** | Grey | No value is set in either source |

### Editing a Secret

Open the row's "..." menu and choose "Edit value" to open the "Edit value" dialog:

1. The dialog shows the secret name, description, and current source information.
2. Enter the new value in the password input field. Toggle visibility with the eye icon.
3. Click "Save value" to encrypt and store the value.

Values are encrypted before storage in the database.

### Deleting a GUI Override

When a secret has a database override (shown as "GUI override"), the row's "..." menu offers "Delete override". Choosing it opens a confirmation dialog, warning that the secret will revert to using the SST value (if configured) and that the override value is not kept; click "Delete override" in the dialog to confirm. This is useful for rolling back an admin-set value.

## Best Practices

- Monitor the Secrets rotation tab regularly to identify secrets approaching their rotation deadline. Overdue rotations show an Overdue status chip.
- Use the System secrets GUI override capability for quick configuration changes, but ensure critical secrets are also properly set in SST for disaster recovery.
- When editing system secrets, use the visibility toggle to verify the entered value before saving.
- Delete GUI overrides when they are no longer needed to keep the secret source clean and traceable.
- The 5-minute auto-refresh on the Secrets rotation tab ensures the display stays current, but use the Refresh button after making changes to see immediate updates.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [Identity Providers](./identity-providers.md) - Configuring SSO identity providers
