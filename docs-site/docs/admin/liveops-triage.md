---
title: LiveOps Triage
description: Configure and manage the automated error triage system that monitors Slack for errors and creates GitHub issues
sidebar_position: 34
tags: [admin, liveops, triage, incidents]
---

# LiveOps Triage

The LiveOps Triage tab provides configuration and monitoring for the automated error triage system. This system monitors a designated Slack channel for error messages, uses AI to triage and prioritize them, and optionally creates GitHub issues automatically. The tab is conditionally displayed based on the deployment environment -- it is hidden on all fork environments.

## Tab Visibility

The LiveOps Triage tab is only shown when the server-side environment check (`/api/admin/liveops-triage-env`) returns `showTab: true`. This check is cached for one hour and is only performed for admin users.

| Environment | Visible? | Reason |
|-------------|----------|--------|
| **Main staging** | Yes | `IS_SOURCE_DEPLOYMENT=true` |
| **Main production** | Yes | `IS_SOURCE_DEPLOYMENT=true` |
| **PR preview** | Yes | Stage starts with `pr` (for testing) |
| **Local development** | Yes | `IS_LOCAL=true` (set by `sst dev`) |
| **Fork staging** | No | Cannot act on alerts |
| **Fork production** | No | Cannot act on alerts |

The tab is hidden from **all fork environments** (both staging and production) because:
- Fork customers cannot modify the source code to act on alerts
- GitHub issues would be created against the wrong repository
- Fork deployments do not have access to the main Slack workspace

## System Health

The top of the configuration panel displays a real-time health status card that monitors the triage system's dependencies and readiness.

### Health Status Indicators

| Overall Status | Color | Description |
|---------------|-------|-------------|
| **Healthy** | Green | All checks passing |
| **Degraded** | Yellow | Some checks have warnings |
| **Unhealthy** | Red | Critical checks failing |

Individual health checks are displayed in a grid, each showing:

- A status icon (checkmark for OK, warning triangle for warning, X for error)
- The check name
- A descriptive message about the check result

Health status refreshes automatically every 60 seconds and can be manually refreshed using the refresh button.

### Dry Run

Click **Run Dry Test** to execute a full triage cycle without creating any actual GitHub issues. Dry runs are disabled when the system health is "unhealthy". The dry run results modal displays:

| Section | Description |
|---------|-------------|
| **Status** | Success or failure of the dry run |
| **Summary** | Alerts fetched, issues that would be created, issues that would be skipped (duplicates), existing issues found |
| **Priority Breakdown** | Count of issues by priority level (P0, P1, P2, P3) |
| **Issues Would Create** | Detailed list of issues that would be created, each with priority chip, title, category, and labels |
| **Issues Would Skip** | List of duplicates that match existing GitHub issues, showing the matching issue number |
| **LLM Details** | Model ID used, estimated cost, prompt length, and response length |
| **Health Assessment** | AI-generated summary of overall system health based on the errors analyzed |

### Last Run Status

When a triage run has previously completed, an alert banner shows the last run timestamp, status (success/failure), number of errors processed, issues created, and issues deduplicated.

## Configuration

### Prerequisites

Before configuring LiveOps Triage, ensure the following are configured:

#### 1. Source Deployment Secret

The `IS_SOURCE_DEPLOYMENT` SST secret must be set to `true` on source deployments (main staging and main production):

```bash
# For main staging (dev stage)
npx sst secret set IS_SOURCE_DEPLOYMENT true --stage dev

# For main production
npx sst secret set IS_SOURCE_DEPLOYMENT true --stage production
```

Without this secret, the LiveOps Triage tab will not be visible. Fork deployments should NOT have this secret set.

#### 2. System Default GitHub Connection

A **System Default GitHub Connection** is required for creating issues:

1. Navigate to **Organization Settings > GitHub**
2. Create a GitHub connection using either:
   - **Service Account PAT** with `repo` scope (simpler setup)
   - **GitHub App** (recommended for production)
3. Enable the **System Default** toggle
4. Add the target repository (e.g., `Bike4Mind/bike4mind`) to the **Allowed Repositories** list
5. Click **Test Connection** to verify access

Without a system default GitHub connection, the LiveOps Triage health check will show an error and triage runs will fail.

### Enable/Disable Toggle

A master toggle controls whether the automated triage system is active. When enabled, triage runs daily at 8:00 AM CST (production only).

### General Settings

| Setting | Description |
|---------|-------------|
| **Slack Channel ID** | The Slack channel to monitor for errors (e.g., `C06CWQNTSAH`) |
| **Lookback Hours** | How many hours of Slack history to scan per run (configurable range) |
| **GitHub Owner** | The GitHub organization or user that owns the target repository |
| **GitHub Repo** | The repository name where issues will be created |
| **Max Errors Per Run** | Maximum number of errors to process in a single triage run (configurable range) |
| **Auto-create GitHub Issues** | Toggle to enable automatic issue creation (when disabled, triage analyzes but does not create issues) |

### LLM Configuration

| Setting | Description |
|---------|-------------|
| **Model** | AI model to use for error triage, selected from available text models grouped by provider |
| **Temperature** | Controls response randomness (lower values produce more consistent triage results) |
| **Max Tokens** | Maximum token budget for the AI response |
| **Timeout (ms)** | Maximum time allowed for the AI model to respond |

### Custom Prompt Template

An optional custom prompt template can be provided to override the default triage prompt. The interface provides:

- **Template variable chips** -- clickable chips for available template variables (e.g., `{{errors}}`, `{{existingIssues}}`). Click a chip to insert the variable at the cursor position, or click the copy icon to copy the variable to the clipboard.
- **View Default Template** button -- opens a modal showing the full default prompt template for reference
- **Textarea** -- a multi-line editor for the custom template. Leave empty to use the default.

Each template variable chip has a tooltip describing what data the variable injects into the prompt.

## Saving Configuration

The configuration form tracks unsaved changes with an "Unsaved changes" chip indicator. Two action buttons are available:

| Button | Description |
|--------|-------------|
| **Reset** | Reverts all changes to the last saved configuration (disabled when no changes exist) |
| **Save Configuration** | Saves the current configuration to the server with validation |

If the server returns validation errors, they are displayed in a red alert box listing each specific error.

## Best Practices

- Start with the system disabled and use **Run Dry Test** to validate your configuration before enabling automated triage.
- Set a reasonable lookback window (e.g., 24 hours) to avoid processing stale errors.
- Keep **Auto-create GitHub Issues** disabled initially until you have verified the AI triage quality through dry runs.
- Use a lower temperature (e.g., 0.3) for more consistent and predictable triage results.
- Monitor the Last Run Status after enabling the system to verify it is operating as expected.
- Review the Priority Breakdown in dry runs to ensure the AI is assigning appropriate priority levels.

---

## Related Articles

- [Slack Workspaces](./slack-workspaces.md) - Managing Slack workspace connections
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
