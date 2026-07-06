---
title: Analytics
description: Platform analytics, user activity tracking, and reporting in the Bike4Mind admin panel
sidebar_position: 6
tags: [admin, analytics, reports]
---

# Analytics

The Analytics tab provides administrators with tools to monitor platform usage, review user activity, and generate daily and weekly reports. It is organized into three sub-tabs, each offering a different perspective on platform data.

## Sub-Tabs

The Analytics tab uses a horizontal tab bar with three sections:

| Sub-Tab | Icon | Description |
|---------|------|-------------|
| **User Activity** | People | Raw activity log data with advanced filtering and export |
| **Daily Report** | Description | AI-generated daily activity summaries |
| **Weekly Report** | Analytics | AI-generated weekly activity summaries |

The active sub-tab is persisted in a Zustand store, so navigating away and returning preserves the last selected sub-tab.

## User Activity Tab

The User Activity tab displays raw activity log entries in a paginated, filterable table. Each entry represents a tracked action on the platform.

### Data Columns

| Column | Description |
|--------|-------------|
| **Date** | The date the activity occurred |
| **Action** | The counter name identifying the type of action (e.g., login, message sent, file uploaded) |
| **User Email** | The email of the user who performed the action, or "N/A" if unavailable |
| **Metadata** | Additional context for the action, displayed as a summary with expandable JSON details |
| **Count** | The number of times this action occurred |

### Metadata Display

Each activity entry can include metadata -- key-value pairs providing additional context. The metadata column shows a summary view by default:

- If there is no metadata, it displays "No metadata"
- If there is a single key, it displays the key and value inline
- If there are multiple keys, it displays the key names as a comma-separated list

Clicking the expand/collapse icon reveals the full metadata as formatted JSON in a monospaced, scrollable container.

### Organization Filter

A multi-select dropdown filters activity by organization:

- **All** - Shows activity from all organizations (default)
- Individual organizations loaded from the API

### Exclude Organizations

When "All" organizations are selected, additional checkboxes allow excluding specific internal organizations from the view:

| Exclusion | Default | Description |
|-----------|---------|-------------|
| **Your internal org** | Checked | Excludes internal team activity |
| **Unknown** | Checked | Excludes activity with no organization |
| **Personal** | Checked | Excludes personal (non-organizational) activity |

These exclusion checkboxes are disabled when a specific organization (not "All") is selected.

### Advanced Filters

Clicking the **Show Advanced Filters** button reveals additional filtering options:

#### Date Filtering

| Control | Description |
|---------|-------------|
| **Start Date** | Date picker, defaults to 7 days ago |
| **End Date** | Date picker, defaults to today |
| **Today** | Quick-select button for today only |
| **Last 7 Days** | Quick-select button for the past week |
| **Last 30 Days** | Quick-select button for the past month |

The active quick-select button is highlighted with a solid style. Start date cannot exceed end date, and end date cannot be in the future.

#### Search Filters

| Filter | Description |
|--------|-------------|
| **Counter Name Search** | Text search to filter by action/counter name |
| **User Email Search** | Text search to filter by user email |

#### Metadata Filters

A metadata filter panel allows filtering based on specific metadata field values. Available metadata fields are dynamically extracted from the raw data.

### Pagination

| Setting | Values |
|---------|--------|
| Items per page | 5, 10 (default), 20 |
| Navigation | Previous / Next buttons with page counter |
| Total count | "Total Items: N" reflecting the filtered result count |

### Export

The **Export CSV** button exports all filtered activity data (not just the current page) to a CSV file named `user_activity_YYYY-MM-DD.csv`. Exported columns include: date, counterName, userEmail, metadata (as JSON string), and count.

### Refresh

The **Refresh** button reloads activity data from the server.

## Daily Report Tab

The Daily Report tab displays AI-generated summaries of platform activity for each day within a selected date range.

### Date Range Selection

The same date filter component used in User Activity is available here:

- **Start Date** and **End Date** pickers
- **Quick select** buttons: Today, Last 7 Days (default), Last 30 Days

### Report Display

Each daily report is displayed as a card with:

- A header showing "Report for YYYY-MM-DD"
- The report content rendered in a monospaced, pre-formatted text block
- Days without activity are marked with "(No Activity)" and displayed with reduced opacity

Reports are sorted by date in descending order (most recent first).

An informational alert notes: "Reports are shown for all dates in the selected range. Dates without activity will be marked accordingly."

### Pagination

| Setting | Values |
|---------|--------|
| Items per page | 5 (default), 10, 20 |
| Navigation | Previous / Next buttons with page counter |
| Total count | "Total Reports: N" |

## Weekly Report Tab

The Weekly Report tab displays AI-generated summaries of platform activity for selected weeks.

### Week Selection

A **Week Picker** component allows selecting one or more weeks:

- Up to **4 weeks** can be selected simultaneously
- Each week is represented by its start and end dates

An informational alert notes: "Select one or more weeks to view reports. You can select up to 4 weeks at a time."

### Report Display

Each weekly report is displayed as a card with:

- A header showing "Week of YYYY-MM-DD to YYYY-MM-DD"
- The report content in monospaced, pre-formatted text
- If an error occurred generating the report, a red alert is shown instead of the report content

When no weeks are selected, a message prompts: "Select one or more weeks to view reports."

## State Management

The Analytics tab uses a centralized Zustand store to persist filter state across sub-tab switches:

| State | Default | Description |
|-------|---------|-------------|
| Active sub-tab | User Activity | The currently selected sub-tab |
| Selected organizations | All | Organization filter selection |
| Excluded orgs | Internal, Unknown, Personal excluded | Organization exclusion toggles |
| Date filters | Last 7 days | Start and end date range |
| User activity filters | Empty strings | Counter name and email search terms |
| Advanced filters visibility | Hidden | Whether advanced filters are shown |

This means that switching between sub-tabs preserves your filter selections, and returning to the Analytics tab from another admin tab maintains your previous state.

## Best Practices

- Start with the **Daily Report** tab for a quick overview of platform health, then drill into **User Activity** for specific details.
- Use the organization exclusion checkboxes to filter out internal team activity when analyzing customer behavior.
- Leverage the **Advanced Filters** for targeted investigations -- combine date ranges with counter name and email searches.
- Export user activity data regularly for compliance or offline analysis purposes.
- When reviewing weekly reports, select consecutive weeks to identify trends over time.
- Use the **Last 30 Days** quick-select for monthly review cycles.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [User Management](./user-management.md) - Managing user accounts
- [Feedbacks](./feedbacks.md) - User feedback management
