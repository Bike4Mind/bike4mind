---
title: Agent Operations
description: Manage system prompt generation settings and meta-prompt templates for AI agents
sidebar_position: 20
tags: [admin, agents, operations]
---

# Agent Operations

The Agent Operations tab (AgentOps), listed as **Agents** in the AI section of the admin sidebar, manages the automated system prompt generation pipeline for AI agents. Agents on the platform have rich personality metadata, and this system uses a "meta-prompt" to instruct an LLM to generate detailed system prompts from that metadata. The tab provides versioned meta-prompt management, LLM model selection, rate limiting, and database repair capabilities.

## System Status Overview

The status strip under the page header displays key operational metrics:

| Metric | Description |
|--------|-------------|
| Service | Enabled or Disabled -- controls whether system prompt generation is active |
| Active meta-prompt | The version number of the currently active meta-prompt template |
| Total generations | Cumulative count of system prompts generated |
| Rate limit | Minimum seconds between generations per agent |
| Model | The model used for generating system prompts |

## Page Actions

The page header has two actions next to the help button:

| Action | Description |
|--------|-------------|
| Create version | Opens a dialog to author a new version of the meta-prompt template |
| Repair database | Runs a database repair operation to fix inconsistencies in AgentOps settings |

The generation model, rate limit and enabled state are edited in the [Generation Settings](#generation-settings) section further down the page.

## Meta-prompt Versions

The versions table tracks all meta-prompt versions:

| Column | Description |
|--------|-------------|
| Version | Version number (e.g., v1, v2, v3) |
| Description | Brief description of the version's purpose or changes |
| Status | "Active" for the currently active version, "Inactive" for others |
| Created | Timestamp of when the version was created |

To make an inactive version the current one, open the **...** menu on its row and choose **Activate version**. Only one version can be active at a time. Activating a new version immediately changes which meta-prompt template is used for all subsequent agent system prompt generations.

### Creating a New Version

The **Create version** dialog provides:

- **Description** -- A text field for a brief description of this version
- **Meta-prompt content** -- A large textarea (monospace font) for the meta-prompt template
- **Use default template** -- A button that populates the textarea with the built-in PromptCrafter template

The default template instructs the LLM to:

1. Establish the agent's core identity and personal mission
2. Highlight agency, active projects, and purpose
3. Capture personality traits, quirks, and communication patterns
4. Define interaction style and approach to problem-solving
5. Include practical guidelines for distinctive behavior

The meta-prompt content field is required; the **Create version** button is disabled until content is entered.

## Generation Settings

The **Generation settings** section at the bottom of the page holds these fields:

| Setting | Description | Range |
|---------|-------------|-------|
| Model | The AI model used to generate agent system prompts | Dropdown of supported models |
| Rate limit (seconds) | Minimum seconds between system prompt generations per agent | 0-3600 |
| Enable system prompt generation | Master toggle for the generation service | On/Off |

Changes are not saved as you type. A save bar appears at the bottom of the page with the number of unsaved changes, **Discard** and **Save**. If you leave the page with unsaved changes, you are asked to confirm before they are discarded.

### Available LLM Models

For example, the **Model** dropdown may include:

| Model | Label |
|-------|-------|
| global.anthropic.claude-opus-5-5 | Claude Opus 5.5 |
| global.anthropic.claude-sonnet-5-5 | Claude Sonnet 5.5 |
| global.anthropic.claude-haiku-5-5 | Claude Haiku 5.5 |
| gpt-5.5 | GPT-5.5 |
| gpt-6-sol | GPT-6 Sol |
| o3-2025-04-16 | O3 |
| gemini-3.8-flash | Gemini 3.8 Flash |
| grok-4.7 | Grok 4.7 |

The dropdown lists the text models in the platform model catalog (the same list `/api/models` returns), best-ranked first, so the exact list can differ from the table. It is not filtered by your organization's enabled models. A model that is currently unavailable is shown as "(unavailable)" and cannot be newly selected; a saved model that has left the catalog is shown as "(no longer available)". Where the same model name is offered by more than one provider, the label carries the provider so the options can be told apart.

## Database Repair

The **Repair database** button triggers a server-side repair operation that checks for and fixes inconsistencies in the AgentOps settings data. This is useful if:

- Meta-prompt versions are corrupted or missing
- The active version pointer is invalid
- Settings data has become inconsistent

After repair, the page reloads its data to display the corrections. The repair result lists all repairs that were made.

## Best Practices

- **Version Before Changing** -- Always create a new meta-prompt version rather than editing the active one, so you can revert if needed
- **Use the Default Template as a Starting Point** -- The built-in PromptCrafter template is well-tested; customize it incrementally
- **Set Appropriate Rate Limits** -- A rate limit of 60 seconds prevents excessive API calls while still allowing prompt regeneration when agent metadata changes
- **Choose the Right Model** -- Higher-capability models (Claude Opus 5.5, Claude Fable 5.1) produce richer system prompts but cost more; balance quality with budget
- **Monitor Generation Count** -- The total generations counter helps track usage and costs over time
- **Repair When Issues Arise** -- If agents appear to have missing or incorrect system prompts, run a database repair before investigating further

## Related Articles

- [System Prompts](./system-prompts.md)
- [LLM Dashboard](./llm-dashboard.md)
- [Admin Settings](./admin-settings.md)
