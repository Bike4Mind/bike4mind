---
title: Tool Definitions
description: Browse, search, edit, and manage AI tool definitions used by the platform
sidebar_position: 17
tags: [admin, tools, definitions, ai]
---

# Tool Definitions

The Tool Definitions tab provides an administrative interface for managing the AI tools available on the platform. Tools can originate from code (built-in) or from database overrides (customized). Administrators can search, filter, view, edit, and revert tool configurations.

## Interface Overview

The page header displays the title "Tool Definitions" with a refresh button to reload the tool list from the server.

## Filtering and Search

Three filter controls are available in a card above the table:

| Filter | Type | Description |
|--------|------|-------------|
| Search | Text input with debounce (300ms) | Searches by tool name, description, or tags |
| Category | Dropdown | Filter by tool category (populated dynamically from available categories) |
| Status | Dropdown | Filter by Enabled, Disabled, or All Status |

A results summary below the filters shows the count of displayed tools out of the total, along with the current page when pagination is active.

Changing any filter automatically resets the pagination to page 1.

## Tools Table

The main table displays tools with the following columns:

| Column | Width | Description |
|--------|-------|-------------|
| Tool Name | 20% | Tool identifier with tags displayed below. Shows an "Override" chip if the tool has a database override. Up to 2 tags are shown inline; additional tags display as a "+N" chip |
| Short Description | 25% | Truncated to 2 lines with a tooltip showing the full text |
| Category | 12% | Tool category as a chip |
| Source | 8% | "DB" for database overrides, "Code" for built-in tools |
| Version | 6% | Version number (e.g., "v1", "v2") or "-" for unversioned tools |
| Usage | 8% | Total invocation count |
| Success | 8% | Success rate as a percentage, color-coded green for 90% or above and red below |
| Status | 6% | Green checkmark for enabled, red X for disabled |
| Actions | 10% | View, Edit, and Revert buttons |

## Actions

### View Details

The view modal displays comprehensive tool information:

- **Tool ID** -- The unique identifier (monospace font)
- **Category** -- Tool category
- **Tags** -- All associated tags as chips
- **Short Description** -- The UI-facing description
- **Full Description** -- The complete description in a scrollable pane
- **Source** -- "Database Override" or "Code"
- **Version** -- Version number or "N/A"
- **Status** -- Enabled or Disabled
- **Usage Count** -- Total invocations
- **Success Rate** -- Percentage with color coding
- **Last Updated By** -- Editor name and timestamp (if available)

### Edit Tool

The edit modal allows modifying three fields:

| Field | Description | Limits |
|-------|-------------|--------|
| Short Description | Brief text for UI display | 10-500 characters |
| Full Description | Detailed description following a 5-section template (DATA TYPE, WHEN TO USE, WHEN NOT TO USE, RETURNS, EXAMPLE QUESTIONS) | 50-10,000 characters |
| Enabled | Toggle switch for enabling or disabling the tool | -- |

The save button is disabled until at least one field has been changed. An informational alert shows the version that will be created (e.g., "Saving will create version 2" for an existing override, or "This will create the first override (v1) for this code-only tool" for a new override).

### Revert to Code Defaults

For tools with database overrides, a revert button (restore icon) appears. Clicking it prompts for confirmation, then deletes the database override, restoring the tool to its original code-defined configuration.

## Pagination

The table displays 50 tools per page. When multiple pages exist, pagination controls appear below the table:

- Previous and Next arrow buttons
- Up to 5 page number buttons with intelligent windowing around the current page
- Buttons are disabled when at the first or last page

## Empty State

When no tools match the current filters, a centered message displays "No Tools Found" with a suggestion to adjust filters (or a note that no tools are loaded if no filters are active).

## Best Practices

- **Use Search for Quick Access** -- The debounced search is efficient for locating specific tools by name or description keywords
- **Review Before Editing** -- Use the View modal to review the full tool definition before making changes in the Edit modal
- **Version Awareness** -- Each edit creates a new version; review the version number before saving to track change history
- **Revert with Caution** -- Reverting to code defaults permanently deletes the database override; this cannot be undone
- **Monitor Success Rates** -- Tools with low success rates (below 90%) may need description improvements to help the AI select them correctly

## Related Articles

- [LLM Dashboard](./llm-dashboard.md)
- [Agent Operations](./agent-operations.md)
- [System Prompts](./system-prompts.md)
