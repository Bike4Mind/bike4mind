---
title: LLM Dashboard
description: Manage LLM model configurations, access control, ranking, and fallback behavior
sidebar_position: 16
tags: [admin, llm, models, ai]
---

# LLM Dashboard

The LLM Dashboard provides a comprehensive interface for managing all large language model (LLM) configurations on the platform. Administrators can enable or disable models, control user access through tag-based permissions, set model ranking priorities, configure fallback behavior, and save changes in bulk.

## Statistics Overview

The top of the dashboard displays four summary cards:

| Card | Description |
|------|-------------|
| Enabled Models | Count of currently active models (excludes speech-to-text) |
| Disabled Models | Count of currently inactive models (excludes speech-to-text) |
| Text Models | Count of enabled text generation models |
| Image Models | Count of enabled image generation models |

## Filters

Three filter controls allow narrowing the model list:

| Filter | Options | Description |
|--------|---------|-------------|
| Type | All Types, Text Models, Image Models | Filter by model capability type |
| Backend | All Backends, OpenAI, Anthropic, Gemini, BFL, and others | Filter by the provider backend |
| Status | All Models, Enabled Only, Disabled Only | Filter by enabled/disabled state |

Filters reset the pagination to page 1 when changed.

## Model Access Control

An informational banner at the top explains the access control model:

> When a model is disabled, all users lose access. User tag permissions control which user groups can access enabled models.

### Tag-Based Permissions

Each model has a set of allowed user tags that control which user groups can access it. The predefined tags are:

| Tag | Color | Description |
|-----|-------|-------------|
| Developer | Warning (amber) | Users tagged as developers |
| Analyst | Primary (blue) | Users tagged as analysts |
| Customer | Danger (red) | Users tagged as customers |

Custom tags are also supported. Tags assigned to users in the system are automatically discovered and displayed alongside the predefined tags. Administrators toggle checkboxes in the "Users Allowed" column to grant or revoke model access for each tag.

Admin users always have access to all enabled models regardless of tag assignments.

## Models Table

The main table displays one row per model (speech-to-text models are excluded) with the following columns:

| Column | Sortable | Description |
|--------|----------|-------------|
| Model | Yes | Model display name |
| Type | Yes | Text or Image, shown as a colored chip |
| Backend | Yes | Provider name (OpenAI, Anthropic, Gemini, BFL) with color coding |
| Status | Yes | Toggle switch to enable or disable the model |
| Rank | Yes | Numeric priority (1-100, lower is higher priority). Leave empty for automatic ranking |
| Fallback Model | No | Dropdown to select a fallback model of the same type when this model fails |
| Created | Yes | Date the model configuration was created |
| Updated | Yes | Date the model configuration was last modified |
| Users Allowed | No | Checkbox grid for tag-based access control |

### Sorting

Click any sortable column header to toggle between ascending and descending sort order. An arrow icon indicates the current sort direction; an unfold icon indicates the column is not currently sorted.

### Fallback Models

Each model can have a fallback model configured. The fallback dropdown only shows models that:

- Are a different model than the current one
- Are currently enabled
- Are of the same type (text or image)

When a model fails, requests are automatically redirected to the configured fallback.

### Rank

The rank field accepts values from 1 to 100, where lower values indicate higher priority in model selection. Leaving the field empty uses automatic ranking. This is useful for controlling which model is selected by default when multiple models are available.

## Pagination

The table supports pagination with configurable rows per page:

| Control | Options |
|---------|---------|
| Rows per page | 5, 10, 25, 50 |
| Navigation | First, Previous, Next, Last buttons |
| Position indicator | Shows current range and total count |

## Saving Changes

All changes are tracked locally until explicitly saved:

- An **Unsaved Changes** warning banner appears when modifications exist
- The **Save Changes** button becomes active and turns primary blue
- After saving, the button shows "Saved" in green and becomes disabled
- Saving persists all model configurations (enabled state, tags, rank, fallback) in a single operation

## Best Practices

- **Disable Before Removing** -- Disable a model before removing its API key to prevent errors for active users
- **Set Fallbacks** -- Configure fallback models for critical text and image models to ensure service continuity
- **Use Tags Thoughtfully** -- Assign model access based on user roles to manage costs and control access to expensive models
- **Rank Priority Models** -- Set explicit ranks for your preferred models so they are selected first in automatic model selection
- **Save Frequently** -- The dashboard does not auto-save; use the Save Changes button after making adjustments

## Related Articles

- [Admin Settings](./admin-settings.md)
- [Tool Definitions](./tool-definitions.md)
- [Rapid Reply](./rapid-reply.md)
