---
title: Metrics
description: Monitor platform performance through Model Metrics, Event Metrics, and Slack Metrics dashboards in the admin panel
sidebar_position: 27
tags: [admin, metrics, analytics, monitoring]
---

# Metrics

The admin panel provides three dedicated metrics tabs for monitoring different aspects of platform activity: **Model Metrics** for AI model performance, **Event Metrics** for system-wide event tracking, and **Slack Metrics** for Slack integration analytics. Each tab offers filtering, visualization, and data exploration capabilities.

## Model Metrics

The Model Metrics tab provides detailed analytics on AI model usage and performance across the platform. It is accessible from the General Ops section of the admin sidebar.

### Filters

The control panel at the top of Model Metrics supports the following filters. Filters are applied explicitly by clicking an Apply button, allowing you to configure multiple filter criteria before fetching data.

| Filter | Description |
|--------|-------------|
| **Date Range** | Start and end dates with preset shortcuts |
| **User** | Filter by specific user |
| **Model** | Filter by AI model |
| **Status** | Filter by request status |
| **Simplified Names** | Toggle to show simplified model names instead of full identifiers |

### Tabs

Model Metrics is organized into three sub-tabs:

| Tab | Description |
|-----|-------------|
| **Overview** | Summary cards and charts showing key metrics and distributions for the filtered dataset |
| **Analytics** | Detailed chart visualizations with trend analysis based on the applied filters |
| **Raw Data** | A sortable table of individual metric records with all fields visible. Supports column sorting and includes access to performance metrics documentation via an info modal. |

### CSV Export

Click the **Export CSV** button in the control panel to download the current filtered and sorted dataset as a CSV file. The filename includes a timestamp (e.g., `model-metrics-2026-02-15-14-30-00.csv`).

### Performance Metrics Info

The Raw Data tab includes an info modal that documents performance metrics fields, including streaming performance data (chunk count, total stream time) when available in the dataset.

### Record Count

A counter displays "Showing X of Y records" to indicate how many records match the current filters out of the total dataset.

## Event Metrics

The Event Metrics tab tracks system-wide events across the platform, providing visibility into user actions, system events, and integration activity.

### Filters

| Filter | Description |
|--------|-------------|
| **Date Range** | Start and end dates with preset shortcuts |
| **User** | Filter by specific user |
| **Event** | Filter by event type |
| **Event Category** | Filter by event category (e.g., Slack, System, User) |

Like Model Metrics, filters are applied explicitly with an Apply button.

### Tabs

Event Metrics is organized into two sub-tabs:

| Tab | Description |
|-----|-------------|
| **Overview** | Summary visualizations and charts for the filtered event data |
| **Curation Breakdown** | Detailed breakdown of events by curation category, showing distribution patterns |

### Record Count

A counter displays "Showing X of Y events" for the current filter state.

## Slack Metrics

The Slack Metrics tab provides focused analytics for Slack integration usage. It reuses the Event Metrics filtering infrastructure but automatically restricts the data to the "Slack" event category (the category filter selector is hidden in the UI).

### Filters

| Filter | Description |
|--------|-------------|
| **Date Range** | Start and end dates with preset shortcuts |
| **User** | Filter by specific user |
| **Event** | Filter by specific Slack event type |

### Visualizations

The Slack Metrics tab displays several chart panels:

| Chart | Description |
|-------|-------------|
| **Slack Event Activity** | Horizontal bar chart showing event counts by type |
| **Agent Usage** | Donut/pie chart showing distribution of agent persona usage in Slack interactions |
| **Intent Breakdown** | Donut/pie chart showing the distribution of detected intents |
| **Export Formats** | Donut/pie chart showing which export formats (JSON, CSV, Markdown) are used |
| **Export Success Rate** | Pie chart showing the ratio of successful to failed exports |

When no Slack data is available, a placeholder message indicates that events will appear once Slack integration activity is tracked.

### Error Handling

If the metrics data fails to load, an error alert is displayed with a **Retry** button to re-fetch the data.

## Best Practices

- Use date range filters to scope queries to relevant time periods, which improves load times and chart readability.
- Apply filters before switching between sub-tabs -- the filtered dataset persists across tabs within each metrics view.
- Use the CSV export in Model Metrics to perform offline analysis or share data with stakeholders.
- Monitor the Slack Metrics export success rate to identify integration reliability issues.
- Check the Event Metrics Curation Breakdown to understand content categorization patterns.

---

## Related Articles

- [Slack Workspaces](./slack-workspaces.md) - Managing Slack workspace connections
- [Model Logs](./model-logs.md) - Detailed model execution logs
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
