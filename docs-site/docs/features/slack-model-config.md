---
title: Slack AI Model Configuration
description: How to configure AI model defaults per organization, channel, and agent
sidebar_position: 12
tags: [slack, ai-models, configuration, organization]
---

# Slack AI Model Configuration

Bike4Mind lets you control which AI model is used when responding in Slack at three levels: organization-wide defaults, per-agent preferences, and per-channel overrides. Org and channel settings are managed from the Slack App Home tab. Agent model preferences are configured in the web app.

## Who Can Configure Models?

Only **Slack workspace admins and owners** see the AI Model Settings section on the App Home tab. Regular users are not shown configuration controls.

You must also have your Slack account **linked** to a Bike4Mind account with an organization.

## Organization Defaults

Organization defaults apply to every channel in the workspace unless a channel-specific override exists.

### Setting Org Defaults

1. Open the **App Home** tab in Slack (click the bot in the sidebar)
2. Scroll to **AI Model Settings** at the bottom
3. Under **Default Settings**, click **Edit**
4. Configure any combination of:
   - **AI Model** -- select from a dropdown of all enabled models, grouped by provider (OpenAI, Anthropic, Bedrock, Gemini, xAI, Ollama, AWS)
   - **Temperature** -- controls response randomness (0.0 = deterministic, 2.0 = creative)
   - **Max Tokens** -- limits response length (1 to 200,000)
5. Click **Save**

Leave any field empty to inherit the system default (GPT-4.1 Mini, temperature 0.9, 4000 tokens).

### Clearing Org Defaults

To reset back to system defaults, open the Edit modal and clear all fields, then save. The display will update to show "Using system defaults."

## Channel Overrides

Channel overrides let you assign a different model to specific channels. A `#research` channel might use a more capable model while `#general` stays on the default.

### Adding a Channel Override

1. In **AI Model Settings**, click **Configure Channel**
2. Select the target channel from the dropdown
3. Set the model, temperature, and/or max tokens
4. Click **Save**

The channel now appears in the overrides list with its configuration.

### Editing a Channel Override

Click **Edit** next to the channel override you want to change. The modal opens pre-filled with the current settings.

### Removing a Channel Override

Click **Remove** next to the channel override. The channel immediately reverts to organization defaults (or system defaults if no org defaults are set).

### Default GitHub Repository per Channel

The channel config modal also accepts a **Default GitHub Owner** and **Default GitHub Repository**. When set, GitHub issues created from that channel without an explicitly named repository (for example, `@dev create an issue for the login bug`) are routed to `owner/repo` automatically.

- Enter the owner (user or organization) and the repo name separately -- e.g. owner `my-org`, repository `my-app`.
- Both fields must be set together; a value in only one of them is rejected on save.
- An explicitly named repository in the user's message always overrides the channel default.
- Clear both fields and save to remove the default; issue creation then falls back to asking the user or inferring from context, as before.

Configured defaults are shown in the channel overrides list on the App Home tab (e.g. ``Repo: `my-org/my-app` ``).

## Agent Model Configuration

**Custom agents** you create in the web app can have their own model preferences. This is useful when a specific agent should always use a particular model regardless of org settings.

The built-in agents (`@dev`, `@pm`, `@analyst`, `@researcher`, `@agent`) do not have model preferences set by default -- they inherit from the organization or system defaults. To give a built-in persona its own model, create a custom agent with the desired settings.

### Setting Custom Agent Model Preferences

1. Go to **Agents** in the web app sidebar
2. Create a new agent (or edit an existing custom agent)
3. Expand the **Model Configuration** section
4. Set any combination of model, temperature, and max tokens
5. Save the agent

When that custom agent is invoked in Slack, its model preferences are used unless the channel has an override.

Leave fields empty to inherit from the organization or system defaults.

## How Model Resolution Works

When a user mentions an agent (for example, `@dev` or `@pm`) in a channel, the system determines which model to use by checking each configuration layer in order:

1. **Channel override** -- if the channel has a specific config, use it
2. **Agent config** -- if the invoked agent has model preferences (set in the web app), use them
3. **Organization defaults** -- if the workspace org has defaults, use them
4. **System defaults** -- GPT-4.1 Mini, temperature 0.9, 4000 tokens

Each field (model, temperature, max tokens) resolves **independently**. A channel override could set only the model while inheriting temperature from the agent config and max tokens from the system default.

### Example

Suppose your org default is GPT-4.1 Mini, you have a custom agent `@codebot` configured with Claude 4 Sonnet, and `#engineering` has a channel override for GPT-4.1:

- Mentioning `@codebot` in `#general` uses **Claude 4 Sonnet** (custom agent config wins, no channel override)
- Mentioning `@codebot` in `#engineering` uses **GPT-4.1** (channel override wins over agent config)
- Mentioning `@dev` (built-in, no model set) in `#general` uses **GPT-4.1 Mini** (falls through to org default)
- Mentioning `@dev` in `#engineering` uses **GPT-4.1** (channel override applies)

## Dynamic Model List

The model dropdown in configuration modals shows the same models available in the web app:

- Models are fetched from all configured backends (OpenAI, Anthropic, AWS Bedrock, Gemini, xAI, Ollama)
- Models disabled by the system admin in the LLM Dashboard are excluded
- Deprecated models are automatically filtered out
- Models are grouped by provider for easier navigation

If your admin enables or disables a model in the web app LLM Dashboard, the Slack dropdown updates automatically on next modal open.

## Troubleshooting

### I don't see the AI Model Settings section

- Verify you are a Slack workspace **admin or owner** (check Slack workspace settings)
- Make sure your Slack account is linked to a Bike4Mind account with an organization

### The model dropdown is empty

- Your system admin may not have configured any LLM API keys
- Check the web app LLM Dashboard to verify models are enabled

### Changes don't seem to take effect

- Model resolution is logged server-side. Ask your admin to check CloudWatch logs for `modelSource` entries to verify which layer is being used
- Channel overrides always win over org defaults -- check if the channel has an override set

---

## Related Features

- [Slack Multi-Workspace OAuth](./slack-multi-workspace-oauth.md) - Connect Slack workspaces to Bike4Mind
- [Organization Slack Integration](./org-slack-self-service.md) - Org-level Slack workspace setup
- [AI Models](./ai-models.md) - Overview of available AI models
- [Organizations & Teams](./organizations-teams.md) - Manage your organization
