---
title: Model Logs
description: View and filter detailed model response logs including performance metrics, token usage, and execution tracking
sidebar_position: 31
tags: [admin, logs, models, debugging]
---

# Model Logs

The Model Logs tab displays detailed logs of individual AI model responses, providing visibility into performance metrics, token usage, execution steps, and generated artifacts. This tab is useful for debugging model behavior, monitoring response quality, and tracking resource consumption.

## Filters

The filter panel at the top of the tab provides three filter controls arranged in a grid:

| Filter | Description |
|--------|-------------|
| **Date Range** | Start and end date pickers with quick-select preset buttons for common ranges (e.g., last 7 days, last 30 days). Defaults to the last 7 days. Selected dates use UTC boundaries and include the entire end date. |
| **Model** | Dropdown to filter by a listed model, or choose All Models |
| **Search** | Case-insensitive text search across model names, saved prompts, and execution step names |

A **Refresh** button in the header reloads the current page and any expanded details with the current filters applied. Changing a filter or the page size returns you to the first page.

## Log Entry Fields

Each log entry is displayed as a card with two rows of information:

### Primary Row

| Field | Description |
|-------|-------------|
| **Model** | The name of the AI model used for the response |
| **Timestamp** | When the response was generated (formatted as `YYYY-MM-DD HH:mm:ss`) |
| **Response Time** | Total response time in milliseconds |
| **Token Usage** | Input and output token counts (e.g., "1,234 in / 567 out") |

### Secondary Row

| Field | Description |
|-------|-------------|
| **Context** | Number of attached files and message history length |
| **Execution Steps** | Count of completed and failed execution steps |

### Artifacts

If the model response produced artifacts, they are listed below the secondary row with:

- Total artifact count
- Each artifact's type and a preview of its content (first 100 characters)

### Log Details

Select **Show details** on a card to load that log's recorded metadata as formatted JSON. Details load only when you open them; the initial list contains card summaries. Select **Hide details** to collapse the JSON. Owner-only tool output, tool errors, and citation context are omitted from this view.

## Pagination

The list loads one page at a time from the server, with controls at the bottom:

| Control | Description |
|---------|-------------|
| **Previous / Next** | Navigate between pages |
| **Page indicator** | Shows current page number and total pages |
| **Items per page** | Radio buttons to select 10, 25, or 50 items per page; defaults to 10 |
| **Total Logs** | Displays the total number of logs matching the current filters |

Logs are sorted by timestamp in descending order (newest first). You can browse up to 10,000 pages. If more logs match, narrow your filters to see additional logs.

## Empty State

When no logs match the current filter criteria, a message reads "No logs found for the selected filters."

## Troubleshooting

If the list displays "Could not load model logs.", select **Try again** to request the current page again. A failed request displays an error rather than the empty-state message.

If an expanded card displays "Could not load log details.", select its **Try again** button to reload that log. The list remains available while you retry details.

If no logs match, check the date range, model, and search filters. The date range uses UTC boundaries, while card timestamps use your browser's time zone.

## Best Practices

- Start with a narrow date range (last 7 days) and expand if needed to avoid loading excessive data.
- Use the model filter to isolate performance comparisons between different AI models.
- Monitor response times and token usage to identify unusual spikes or degradation.
- Check execution step failure counts to identify reliability issues with specific model workflows.

---

## Related Articles

- [Metrics](./metrics.md) - Model and event metrics analytics
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
