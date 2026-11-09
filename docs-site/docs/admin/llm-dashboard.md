---
title: LLM Dashboard
description: Manage LLM model configurations, access control, ranking, and fallback behavior
sidebar_position: 16
tags: [admin, llm, models, ai]
---

# LLM Dashboard

The LLM Dashboard is the **Models** page in the AI section of the admin sidebar. It provides a comprehensive interface for managing all large language model (LLM) configurations on the platform. Administrators can enable or disable models, control user access through tag-based and entitlement-based permissions, set model ranking priorities, configure fallback behavior, and save changes in bulk.

## Statistics Overview

Below the page header and the access control banner, a strip shows four counts:

| Count        | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| Enabled      | Count of currently active models (excludes speech-to-text)   |
| Disabled     | Count of currently inactive models (excludes speech-to-text) |
| Text models  | Count of enabled text generation models                      |
| Image models | Count of enabled image generation models                     |

## Filters

A search box and three filter chips narrow the model list:

| Filter  | Options                                    | Description                                    |
| ------- | ------------------------------------------ | ---------------------------------------------- |
| Search  | Free text                                  | Matches the model id, name, backend, or vendor |
| Type    | Text, Image                                | Filter by model capability type                |
| Backend | openai, anthropic, gemini, bfl, and others | Filter by the provider backend                 |
| Status  | Enabled, Disabled                          | Filter by enabled/disabled state               |

A chip with no value set shows every model; click the x on a set chip to clear it. Filters return the table to page 1 when changed. When the filters match no models, the table says so and offers **Clear filters**.

## Model Access Control

A banner under the page header explains the access control model:

> When a model is disabled, all users lose access. The user tag and entitlement columns control which users can access an enabled model.

### Tag-Based Permissions

Each model has a set of allowed user tags that control which user groups can access it. The predefined tags are:

| Tag       | Description                |
| --------- | -------------------------- |
| Developer | Users tagged as developers |
| Customer  | Users tagged as customers  |

Custom tags are also supported. Tags assigned to users in the system are automatically discovered and displayed alongside the predefined tags. Each tag has its own column in the table, named after the tag (for example, "Developer users"). Check a box to let users with that tag access the model; clear it to revoke access.

### Entitlement-Based Permissions

Each entitlement key also has its own column, named after the key (for example, "base"). Check a box to let users who hold that entitlement access the model. A user can access an enabled model when they have any one of its checked tags or entitlements.

Admin users always have access to all enabled models regardless of tag or entitlement assignments.

## Models Table

The main table displays one row per model (speech-to-text models are excluded) with the following columns:

| Column                         | Sortable | Description                                                                           |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| Model                          | Yes      | Model display name                                                                    |
| Type                           | Yes      | Text or Image                                                                         |
| Backend                        | Yes      | Provider name (openai, anthropic, gemini, bfl, and others)                            |
| Status                         | Yes      | Toggle switch to enable or disable the model                                          |
| Rank                           | Yes      | Numeric priority (1-100, lower is higher priority). Leave empty for automatic ranking |
| Fallback model                 | No       | Dropdown to select a fallback model of the same type when this model fails            |
| Created                        | Yes      | Date the model configuration was created                                              |
| Updated                        | Yes      | Date the model configuration was last modified                                        |
| One column per user tag        | No       | Checkbox for tag-based access control, for example "Developer users"                  |
| One column per entitlement key | No       | Checkbox for entitlement-based access control, for example "base"                     |

The table keeps every column at full width. When it is wider than the page, it scrolls sideways inside its own frame, and its header row stays in view while you scroll down.

### Sorting

Click any sortable column header to toggle between ascending and descending sort order. An arrow after the header label shows the current sort direction.

### Fallback Models

Each model can have a fallback model configured. The fallback dropdown only shows models that:

- Are a different model than the current one
- Are currently enabled
- Are of the same type (text or image)

When a model fails, requests are automatically redirected to the configured fallback.

### Rank

The rank field accepts values from 1 to 100, where lower values indicate higher priority in model selection. Leaving the field empty uses automatic ranking. This is useful for controlling which model is selected by default when multiple models are available.

### Bulk Changes

Use the checkbox at the start of each row to select models. The checkbox in the header selects every row on the current page. While models are selected, a bar at the bottom of the page shows how many are selected and offers:

- **Select all N matching** to select every model that matches the current filters, across all pages
- **Clear selection**
- **Enable selected** and **Disable selected**, which change only the selected models that match the current filters

The selection is kept when you change the filters. If some selected models are hidden by the current filters, the bar says how many of them match.

## Pagination

The table footer pages through the models:

| Control            | Options                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| Rows per page      | 25, 50, 100                                                               |
| Navigation         | Previous and Next buttons                                                 |
| Position indicator | Shows the current range and the total count, for example "1 to 25 of 120" |

## Saving Changes

All changes are tracked locally until explicitly saved:

- When you change a model, a save bar appears at the bottom of the page with the number of models you changed
- Changing a value back to what was loaded removes that model from the count
- **Discard** restores the configuration as it was last loaded or saved
- **Save** (or Cmd+S on macOS, Ctrl+S elsewhere) persists all model configurations (enabled state, tags, entitlements, rank, fallback) in a single operation
- Leaving the page with unsaved changes asks you to confirm before your changes are discarded

## Best Practices

- **Disable Before Removing** -- Disable a model before removing its API key to prevent errors for active users
- **Set Fallbacks** -- Configure fallback models for critical text and image models to ensure service continuity
- **Use Tags Thoughtfully** -- Assign model access based on user roles to manage costs and control access to expensive models
- **Rank Priority Models** -- Set explicit ranks for your preferred models so they are selected first in automatic model selection
- **Save Frequently** -- The dashboard does not auto-save; use **Save** in the save bar after making adjustments

## Related Articles

- [Admin Settings](./admin-settings.md)
- [Tool Definitions](./tool-definitions.md)
- [Rapid Reply](./rapid-reply.md)
