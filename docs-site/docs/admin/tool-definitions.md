---
title: Tool Definitions
description: Browse, search, edit, and manage AI tool definitions used by the platform
sidebar_position: 17
tags: [admin, tools, definitions, ai]
---

# Tool Definitions

The **Tools** tab provides an administrative interface for managing the AI tools available on the platform. Tools can originate from code (built-in) or from database overrides (customized). Administrators can search, filter, view, edit, and revert tool configurations.

## Interface Overview

The page header shows the title "Tools" with the number of tools, a help button and a **Refresh** button that reloads the tool list from the server.

## Filtering and Search

The filter bar sits above the table:

| Filter | Type | Description |
|--------|------|-------------|
| Search | Search box with debounce (300ms) | Searches by tool name, description, or tags |
| Category | Filter chip | Filter by tool category (populated dynamically from available categories) |
| Status | Filter chip | Filter by Enabled or Disabled |

A filter chip applies as soon as you pick a value; the x on a set chip clears it. Changing any filter automatically resets the pagination to page 1.

## Tools Table

Names and descriptions do not wrap: a long one is cut short with an ellipsis. On a narrow screen the table scrolls sideways inside its own frame instead of squeezing the columns. The table has the following columns:

| Column | Description |
|--------|-------------|
| Tool | Tool name, cut short with an ellipsis if it is long (hover it to see the full name). Up to 2 tags are shown below the name; additional tags display as a "+N" chip |
| Short description | One line; hover it to see the full text |
| Category | Tool category as a chip |
| Source | "DB" for database overrides, "Code" for built-in tools |
| Version | Version number (e.g., "v1", "v2") or "-" for unversioned tools |
| Usage | Total invocation count |
| Success | Success rate as a percentage, or N/A for an unused tool |
| Status | Status chip: Enabled (green) or Disabled (grey) |

The row actions are in the "..." menu at the end of each row: **View details**, **Edit tool**, and, for a tool with a database override, **Revert to code defaults**.

**Edit tool** and **Revert to code defaults** need the `settings:manage` permission (see [Delegated permissions](./delegated-permissions.md)). A delegate with only `support:read` can open the page and view details, but sees both actions disabled, with the missing permission named on hover.

## Actions

### View Details

The details dialog, titled with the tool name, displays comprehensive tool information:

- **Tool ID** -- The unique identifier (monospace font)
- **Category** -- Tool category
- **Tags** -- All associated tags as chips
- **Short description** -- The UI-facing description
- **Full description** -- The complete description in a scrollable pane
- **Source** -- "Database override" or "Code"
- **Version** -- Version number or "N/A"
- **Status** -- Enabled or Disabled
- **Usage count** -- Total invocations
- **Success rate** -- Percentage, or N/A for an unused tool
- **Last updated by** -- Editor name and timestamp (if available)

### Edit Tool

The "Edit tool" dialog names the tool at the top and allows modifying three fields:

| Field | Description | Limits |
|-------|-------------|--------|
| Short description | Brief text for UI display | 10-500 characters |
| Full description | Detailed description following a 5-section template (DATA TYPE, WHEN TO USE, WHEN NOT TO USE, RETURNS, EXAMPLE QUESTIONS) | 50-10,000 characters |
| Enabled | Toggle switch for enabling or disabling the tool | -- |

The save button is disabled until at least one field has been changed. A banner shows the version that will be created (e.g., "Saving will create version 2" for an existing override, or "This will create the first override (v1) for this code-only tool" for a new override), and the save button repeats it: "Save changes (create v2)" or "Create override (v1)".

### Revert to Code Defaults

For tools with database overrides, choose **Revert to code defaults** in the row's "..." menu. A confirmation dialog explains that the database override is deleted; confirming with **Revert to code defaults** restores the tool to its original code-defined configuration.

## Pagination

The table shows 50 tools per page by default. The table footer shows the range on the left (for example "1 to 50 of 120"), with a rows-per-page select (25, 50 or 100) and Previous and Next arrow buttons on the right. The arrows are disabled at the first and last page.

## Empty State

When no tools match the current filters, the table shows "No tools match these filters" with a **Clear filters** button. When no tools are loaded at all, it shows "No tools are loaded" with a **Refresh** button.

## Best Practices

- **Use Search for Quick Access** -- The debounced search is efficient for locating specific tools by name or description keywords
- **Review Before Editing** -- Use the details dialog to review the full tool definition before making changes in the edit dialog
- **Version Awareness** -- Each edit creates a new version; review the version number before saving to track change history
- **Revert with Caution** -- Reverting to code defaults permanently deletes the database override; this cannot be undone
- **Monitor Success Rates** -- Tools with low success rates (below 90%) may need description improvements to help the AI select them correctly

## Related Articles

- [Models](./models.md)
- [Agent Operations](./agent-operations.md)
- [System Prompts](./system-prompts.md)
