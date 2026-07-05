---
title: Agent Operations
description: Manage system prompt generation settings and meta-prompt templates for AI agents
sidebar_position: 20
tags: [admin, agents, operations]
---

# Agent Operations

The Agent Operations tab (AgentOps) manages the automated system prompt generation pipeline for AI agents. Agents on the platform have rich personality metadata, and this system uses a "meta-prompt" to instruct an LLM to generate detailed system prompts from that metadata. The tab provides versioned meta-prompt management, LLM model selection, rate limiting, and database repair capabilities.

## System Status Overview

The status card at the top displays key operational metrics:

| Metric | Description |
|--------|-------------|
| Service Status | Enabled or Disabled -- controls whether system prompt generation is active |
| Active Meta-prompt | The version number of the currently active meta-prompt template |
| Total Generations | Cumulative count of system prompts generated |
| Rate Limit | Minimum seconds between generations per agent |
| LLM Model | The model used for generating system prompts |

## Quick Actions

Three action buttons are available:

| Action | Description |
|--------|-------------|
| Create Meta-prompt Version | Opens a modal to author a new version of the meta-prompt template |
| Edit Settings | Opens a modal to configure the generation LLM model, rate limit, and enabled state |
| Repair Database | Runs a database repair operation to fix inconsistencies in AgentOps settings |

## Meta-prompt Versions

The versions table tracks all meta-prompt versions:

| Column | Description |
|--------|-------------|
| Version | Version number (e.g., v1, v2, v3) |
| Description | Brief description of the version's purpose or changes |
| Status | "Active" badge for the currently active version, "Inactive" for others |
| Created | Timestamp of when the version was created |
| Actions | **Activate** button for inactive versions to make them the current version |

Only one version can be active at a time. Activating a new version immediately changes which meta-prompt template is used for all subsequent agent system prompt generations.

### Creating a New Version

The create version modal provides:

- **Description** -- A text field for a brief description of this version
- **Meta-prompt Content** -- A large textarea (monospace font) for the meta-prompt template
- **Use Default Template** -- A button that populates the textarea with the built-in PromptCrafter template

The default template instructs the LLM to:

1. Establish the agent's core identity and personal mission
2. Highlight agency, active projects, and purpose
3. Capture personality traits, quirks, and communication patterns
4. Define interaction style and approach to problem-solving
5. Include practical guidelines for distinctive behavior

The meta-prompt content field is required; the create button is disabled until content is entered.

## Edit Settings

The settings modal allows configuration of:

| Setting | Description | Range |
|---------|-------------|-------|
| LLM Model for Generation | The AI model used to generate agent system prompts | Dropdown of supported models |
| Rate Limit (seconds) | Minimum seconds between system prompt generations per agent | 0-3600 |
| Enable system prompt generation | Master toggle for the generation service | On/Off |

### Available LLM Models

The following models are available for system prompt generation:

| Model | Label |
|-------|-------|
| claude-opus-4-20250514 | Claude 4 Opus (Recommended) |
| claude-sonnet-4-20250514 | Claude 4 Sonnet |
| claude-3-7-sonnet-20250219 | Claude 3.7 Sonnet (Fast) |
| o3-2025-04-16 | OpenAI O3 (Reasoning) |
| gpt-4.1-2025-04-14 | GPT-4.1 (Latest) |
| grok-3 | Grok 3 (xAI Latest) |
| claude-3-5-sonnet-20241022 | Claude 3.5 Sonnet (Reliable) |
| gpt-4o | GPT-4o |
| gpt-4o-mini | GPT-4o Mini (Fast) |
| claude-3-opus-20240229 | Claude 3 Opus (Legacy) |
| claude-3-haiku-20240307 | Claude 3 Haiku (Fastest) |

## Database Repair

The **Repair Database** button triggers a server-side repair operation that checks for and fixes inconsistencies in the AgentOps settings data. This is useful if:

- Meta-prompt versions are corrupted or missing
- The active version pointer is invalid
- Settings data has become inconsistent

After repair, the page automatically reloads to display the corrected data. The repair result lists all repairs that were made.

## Best Practices

- **Version Before Changing** -- Always create a new meta-prompt version rather than editing the active one, so you can revert if needed
- **Use the Default Template as a Starting Point** -- The built-in PromptCrafter template is well-tested; customize it incrementally
- **Set Appropriate Rate Limits** -- A rate limit of 60 seconds prevents excessive API calls while still allowing prompt regeneration when agent metadata changes
- **Choose the Right Model** -- Higher-capability models (Claude 4 Opus, O3) produce richer system prompts but cost more; balance quality with budget
- **Monitor Generation Count** -- The total generations counter helps track usage and costs over time
- **Repair When Issues Arise** -- If agents appear to have missing or incorrect system prompts, run a database repair before investigating further

## Related Articles

- [System Prompts](./system-prompts.md)
- [LLM Dashboard](./llm-dashboard.md)
- [Admin Settings](./admin-settings.md)
