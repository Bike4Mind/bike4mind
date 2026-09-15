---
title: Admin Settings
description: Configure platform-wide settings organized by category tabs and service groups
sidebar_position: 14
tags: [admin, settings, configuration]
---

# Admin Settings

The Admin Settings tab provides a centralized interface for managing all platform configuration values. Settings are organized into category tabs, each containing service groups with related configuration fields. Changes take effect immediately upon saving individual setting values.

## Interface Overview

### Header Controls

The settings page header provides:

- **Search** -- Filter settings by name, description, or (non-sensitive) value. A counter to the left of the **All Tabs** checkbox shows how many settings match across every tab.
- **All Tabs** -- A checkbox that flattens results from every settings tab into a single list (so a match on a tab you are not currently viewing still appears) and also reveals app-scoped settings that are hidden by default

### Category Tabs

Settings are organized into the following tabs, each with a distinctive icon:

| Tab | Categories Included | Description |
|-----|-------------------|-------------|
| AI Configuration | AI, Knowledge | AI model API keys, embedding settings, context configuration |
| External Integrations | Tools, Calendar, Slack | Third-party service connections and API credentials |
| Features | Experimental, Notebooks | Feature flags and experimental feature toggles |
| Security | AI Moderation | Content moderation and access control rules |
| User Management | Users, Referrals | User notification settings, seat defaults, credit enforcement |
| Communications | Admin, Feedback | Feedback channels, email/Slack webhooks, What's New configuration |
| Customization | Branding | Logo uploads, visual branding settings |

## Service Groups

Within each tab, settings are grouped by service. Each service group card displays an icon, group name, and description. The following service groups are available:

### AI Configuration Tab

| Service Group | Settings | Description |
|--------------|----------|-------------|
| OpenAI Service | API key, default context, chunk size, format prompt template, image prompt, URL scanning | OpenAI API integration |
| Anthropic Service | API key | Anthropic API integration |
| Gemini Service | API key | Google Gemini API integration |
| xAI Service | API key | xAI API integration |
| Voyage Service | API key | Voyage AI embedding integration |
| Embedding Service | Default embedding model | Vector embedding configuration |
| Voice Session Service | Enable/disable, AI voice, transcription model | Voice session configuration |
| Knowledge Management | Max file size, vector threshold, max content length | File and vector storage settings |

### External Integrations Tab

| Service Group | Settings | Description |
|--------------|----------|-------------|
| Search Service | Serper API key | Web search integration |
| Google Calendar | Enable/disable, service account email/secret, organizer email | Calendar integration |
| Slack Integration | Signing secret, bot token, workspace configuration | Slack bot settings |
| MCP Server | Enable/disable, GitHub client credentials, Atlassian client credentials | Model Context Protocol integration |

### Features Tab

| Service Group | Settings | Description |
|--------------|----------|-------------|
| Experimental Features | Quest Master, Mementos, Artifacts, Agents, Rapid Reply, Research Engine, Deep Research, Lattice, Knowledge Base Search, Help Chat, and more | Feature flag toggles |
| Notebook Settings | Auto-name notebook | Notebook behavior configuration |

### Communications Tab

| Service Group | Settings | Description |
|--------------|----------|-------------|
| Feedback System | Email/Slack feedback toggles, webhook URLs, feedback email addresses | Feedback routing configuration |

## Special Components

### Operations Model Setting

Located in the AI category, the Operations Model setting allows administrators to select which AI model is used for internal platform operations (such as auto-naming notebooks or generating summaries). The configuration includes:

- **Text Model** -- The primary model for text operations
- **Image Model** -- The model for image-related operations
- **Speech Model** -- The model for speech-to-text operations

### Logo Upload

Located in the Branding category, the Logo Upload component provides:

- **Light Mode Logo** -- Upload a custom logo for light mode display
- **Dark Mode Logo** -- Upload a separate logo for dark mode display
- **Use Both Logos** -- Toggle to enable separate light/dark logos
- Images are automatically compressed to a maximum of 200x200 pixels

### What's New Configuration

Located in the Admin category, this component manages the automated "What's New" notifications that inform users about platform updates. Configuration includes model selection, template editing, and preview capabilities.

### MCP Server Configuration

The MCP tab provides a dedicated form for creating MCP (Model Context Protocol) server configurations:

- **Server Name** -- The identifier for the MCP server
- **Enabled** -- Toggle to enable or disable the server
- **Environment Variables** -- Key-value pairs for server-specific configuration, with the ability to add or remove variables dynamically

## Setting Input Types

Individual settings use one of the following input types based on their data type:

| Type | Control | Behavior |
|------|---------|----------|
| String | Text input field | Free-text entry, with sensitive values masked |
| Number | Numeric input field | Accepts numeric values only |
| Boolean | Toggle switch | On/off toggle for feature flags and enable/disable settings |
| Select | Dropdown | Constrained to predefined options |

Sensitive settings (such as API keys) are marked as such and their values are hidden in the UI.

## Best Practices

- **API Keys** -- Always use the sensitive setting fields for API keys; these values are masked in the UI for security
- **Feature Flags** -- Test experimental features in staging (`dev` stage) before enabling them in production
- **Search** -- Use the search bar to quickly locate specific settings rather than browsing through all tabs
- **All Tabs** -- Enable this to see search matches from every tab in one list (useful when a setting might live on a tab you are not viewing) and to reveal app-scoped settings that are hidden by default

## Related Articles

- [LLM Dashboard](./llm-dashboard.md)
- [System Health](./system-health.md)
- [System Prompts](./system-prompts.md)
