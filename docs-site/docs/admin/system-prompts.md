---
title: System Prompts
description: Manage global system prompt files that are applied to all AI interactions across the platform
sidebar_position: 19
tags: [admin, prompts, ai, system]
---

# System Prompts

The System Prompts tab manages global system prompt files that are automatically included in all AI conversations for all users across the platform. These prompts provide universal instructions, grammar rules, company-wide guidelines, or any other context that should be present in every AI interaction.

## Overview

The tab displays an informational banner explaining its purpose:

> Manage global system prompts that are applied to all AI interactions across the platform.

Below this, the SystemPromptsManager component provides the full file management interface.

## System Files Configuration

### File List

The main area displays all configured system files as individual cards. Each file card shows:

| Field | Description |
|-------|-------------|
| Index Number | Sequential position (e.g., #1, #2) |
| File Name | The name of the uploaded file |
| File Type/MIME Type | The format of the file (e.g., text/plain, application/pdf) |
| File Size | Formatted size (Bytes, KB, MB, GB) |
| File ID | The unique identifier of the file |
| Last Updated | Date the file was last modified |

Each card provides two action buttons:

- **View** (eye icon) -- Opens the file in the Knowledge Modal viewer in read-only mode
- **Remove** (delete icon) -- Removes the file from the global system prompts list (does not delete the file itself)

### Missing Files

If a configured file ID no longer exists in the system (404), it is displayed in a danger-colored card marked "Missing" with a warning icon. A banner at the top alerts the administrator to the number of missing files. Missing file references can be removed using the delete button.

### Empty State

When no system files are configured, a placeholder message reads: "No global system files configured. Add files to provide universal AI instructions."

## Adding System Files

Click the **Add System File** button to open the file picker modal:

1. **Search** -- Type in the search field to filter available files by name (debounced at 300ms)
2. **Browse** -- Scroll through the list of available files in the system
3. **Select** -- Click "Select" on one or more files to mark them for addition. Files already configured as system files show an "Already Added" chip and cannot be re-selected
4. **Confirm** -- Click "Add Selected Files" to add the selected files to the global system prompts

The selection count is displayed at the bottom of the modal.

## How It Works

System files are stored as a comma-separated list of file IDs in the `SystemFiles` admin setting. When AI conversations are initiated, the platform retrieves these files and includes their content as part of the system context for the LLM.

Changes take effect immediately -- adding or removing a system file updates all subsequent AI interactions without requiring a restart.

## Best Practices

- **Keep Files Focused** -- Each system file should address a single concern (e.g., one file for tone guidelines, another for compliance rules) for easier management
- **Monitor File Count** -- Adding many large system files increases the context window usage for every conversation, which can affect response quality and cost
- **Clean Up Missing Files** -- Periodically check for and remove missing file references to keep the configuration clean
- **Use View Before Adding** -- Preview files in the Knowledge Modal before adding them as system prompts to verify their content is appropriate for global inclusion
- **Test Impact** -- After adding a new system prompt file, test several conversations to verify the AI correctly follows the new instructions

## Related Articles

- [Admin Settings](./admin-settings.md)
- [LLM Dashboard](./llm-dashboard.md)
- [Agent Operations](./agent-operations.md)
