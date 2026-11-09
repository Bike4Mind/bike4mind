---
title: System Prompts
description: Manage the prompts AI features run on, and the global knowledge files included in every AI conversation
sidebar_position: 19
tags: [admin, prompts, ai, system]
---

# System Prompts

The **System prompts** tab manages two things: the prompts that AI features run on, and the global knowledge files that are automatically included in all AI conversations for all users across the platform.

## Overview

The page header shows the title "System prompts" with the number of prompts, a help button, a **Refresh** button and a **New prompt** button.

A banner below the header explains how prompts work:

- Prompts load from code defaults. An override changes a prompt live, without a deploy. Overrides are versioned and apply at once wherever the prompt is used.
- Many features pair two prompts: a **System** prompt that sets how the AI behaves, and a **Main** prompt that carries the data and instructions. The chip under each prompt's name shows its role.

## Filtering and Search

The filter bar sits above the table. The search box comes first and matches prompt names, descriptions and tags. Next to it are three filter chips: **Category**, **Source** (Code or DB) and **Status** (Enabled or Disabled). A filter applies as soon as you pick a value; the x on a set chip clears it.

When the filters match nothing, the table shows "No prompts match these filters" with a **Clear filters** button.

## Prompts Table

Names and descriptions do not wrap: a long one is cut short with an ellipsis. On a narrow screen the table scrolls sideways inside its own frame instead of squeezing the columns.

| Column | Description |
|--------|-------------|
| **Name** | The prompt name, cut short with an ellipsis if it is long (hover it to see the full name). A "Default updated" chip appears when the code default has changed since the active override was written. Below the name are the role chip (System or Main) and up to two tags. |
| **Description** | One line; hover it to see the full text |
| **Category** | The prompt category |
| **Source** | "DB" for a prompt with a database override, "Code" for a code default |
| **Latest** | The latest stored version, for DB prompts |
| **Active** | The version the app uses: "Default" for the code default, or a stored version such as "v2" |
| **Usage** | How many times the prompt has run, for DB prompts |
| **Success** | The success rate as a percentage, or N/A when the prompt has not run |
| **Status** | Status chip: Enabled (green) or Disabled (grey) |

You can sort by Name, Category, Source, Usage and Status. The footer shows the range of rows and lets you show 25, 50 or 100 rows per page.

The row actions are in the "..." menu at the end of each row:

- **View details** opens the prompt's details: ID, description, category, tags, supported variables, content, versions, status, usage and who last updated it.
- **Edit override** opens the "Edit prompt" dialog. For a prompt with no override yet, the item reads **Create override**.
- **Delete prompt** appears only for a prompt that exists only in the database (it has no code default). A confirmation dialog asks first; **Delete prompt** then removes the prompt entirely. Its version history is kept.

## Creating and Editing Prompts

**New prompt** in the page header opens the "New prompt" dialog. Enter a **Prompt ID** (lowercase with underscores, for example `sales_briefing_mode`), a **Name**, a **Description**, the **Prompt content**, a **Category**, **Tags**, **Variables** and a **Status**, then click **Create prompt**. A new prompt is available in production as soon as you create it.

The "Edit prompt" dialog names the prompt and its ID at the top and has the same fields, without the Prompt ID:

- For a prompt with no override, **Create override (v1)** saves your changes as the first stored version.
- For a prompt with an override, a version selector next to **Prompt content** lists the latest version, earlier versions and **Default (code)**. The active version is marked with a check. Depending on the version you view and whether you have changed anything, the dialog offers **Use vN** (switch to that version), **Save + Use vN**, **Use default**, **Save to vN** and **Save as new version**.
- When the code default has changed since the override was written, a banner says so and offers **View code default** so you can compare the two.

## Global Knowledge Files

The **Global knowledge files** section, below the prompts, lists the files that are included in every AI conversation for every user. Use them for universal instructions, grammar rules or company-wide guidelines.

### File List

The configured files are listed in one table:

| Column | Description |
|--------|-------------|
| **File** | The name of the uploaded file, or "File not found" for a missing file |
| **ID** | The unique identifier of the file |
| **Type** | The format of the file (e.g., text/plain, application/pdf) |
| **Size** | Formatted size (Bytes, KB, MB, GB) |
| **Updated** | Date the file was last modified |
| **Status** | Available (green) or Missing (red) |

The row actions are in the "..." menu at the end of each row:

- **View file** opens the file in the Knowledge Modal viewer in read-only mode.
- **Remove from list** removes the file from the global knowledge files (it does not delete the file itself).

### Missing Files

If a configured file ID no longer exists in the system (404), its row shows a red "Missing" chip and "File not found". A banner above the table gives the number of missing files. Remove a missing file reference with **Remove from list** in its row menu.

### Empty State

When no files are configured, the table shows "No knowledge files yet" with an **Add files** button.

### Adding Files

Click **Add files** to open the "Add system files" dialog:

1. **Search** -- Type in the search field to filter available files by name (debounced at 300ms)
2. **Browse** -- Scroll through the list of available files in the system
3. **Select** -- Click "Select" on one or more files to mark them for addition. Files already configured show an "Already added" chip and cannot be selected again
4. **Confirm** -- Click "Add selected files" to add the selected files to the global knowledge files

The selection count is displayed at the bottom of the dialog.

## How It Works

Global knowledge files are stored as a comma-separated list of file IDs in the `SystemFiles` admin setting. When AI conversations are initiated, the platform retrieves these files and includes their content as part of the system context for the LLM.

Changes take effect immediately -- adding or removing a file updates all subsequent AI interactions without requiring a restart.

## Best Practices

- **Keep Files Focused** -- Each file should address a single concern (e.g., one file for tone guidelines, another for compliance rules) for easier management
- **Monitor File Count** -- Adding many large files increases the context window usage for every conversation, which can affect response quality and cost
- **Clean Up Missing Files** -- Periodically check for and remove missing file references to keep the configuration clean
- **Use View Before Adding** -- Preview files in the Knowledge Modal before adding them to verify their content is appropriate for global inclusion
- **Test Impact** -- After adding a new file or changing a prompt, test several conversations to verify the AI correctly follows the new instructions

## Related Articles

- [Admin Settings](./admin-settings.md)
- [LLM Dashboard](./llm-dashboard.md)
- [Agent Operations](./agent-operations.md)
