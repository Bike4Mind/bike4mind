---
title: Agents - Custom AI Assistants
description: Create and customize AI agents with unique personalities, expertise, and behaviors
sidebar_position: 4
tags: [agents, ai, customization, personality]
---

# Agents - Custom AI Assistants

Agents are customizable AI personalities that you can create, configure, and use across your notebooks. Each agent has a unique personality, expertise, and behavior style.

> **Availability:** This feature may be enabled or disabled at the organizational level by your administrator. If the toggle is grayed out with "Disabled by administrator," contact your organization admin to request access.

## Enabling Agents

Agents is an experimental feature that must be enabled before it appears in your sidebar.

**To enable Agents:**
1. Click your **avatar** in the sidebar footer to open your Profile
2. Go to the **Settings** tab
3. Scroll to **Experimental Features**
4. Toggle **Agents** on

Once enabled:
- **"Agents"** appears in your left sidebar navigation where you can create, edit, and manage your agents.
- An **Agents** button appears in the chat footer toolbar of every notebook (next to the Smart Tools button), giving you quick access to toggle agents on or off for the current session.

> **Don't see the Agents toggle?** Your organization admin may need to enable it at the organization level first. Contact your admin for access.

---

## Overview

Agents let you:
- **Create specialized assistants** for specific tasks
- **Define personalities** with motivations, quirks, and communication styles
- **Use trigger words** to activate agents in conversations
- **Share agents** publicly or keep them private

---

## Creating an Agent

### Getting Started

1. Navigate to **Agents** in the sidebar
2. Click **Create Agent** or go to `/agents/new`
3. Fill in the configuration sections
4. Click **Create**

### Basic Information

| Field | Description |
|-------|-------------|
| **Name** | Your agent's display name |
| **Description** | What the agent does and excels at |
| **Project** | Associate with a project (optional) |
| **Avatar** | Upload or AI-generate a portrait |
| **Style** | Visual style: Modern, Classic, Futuristic, Minimalist, Playful |

### Trigger Words

Trigger words activate your agent when mentioned in conversations.

- Words must start with `@` (e.g., `@helper`, `@coder`)
- Add multiple trigger words for flexibility
- Users type trigger words in their messages to invoke the agent

**Example:** If your agent has trigger word `@research`, typing "@research find articles about AI" will activate it.

---

## Personality Configuration

### Core Personality (Required)

The four fundamental dimensions that define your agent:

| Dimension | Description | Example |
|-----------|-------------|---------|
| **Major Motivation** | Primary driving force | "Helping users succeed with complex tasks" |
| **Minor Motivation** | Secondary drivers | "Learning new technologies" |
| **Flaw** | Character weakness | "Sometimes overexplains simple concepts" |
| **Quirk** | Unique personality trait | "Uses nautical metaphors frequently" |

### Agency & Purpose (Optional)

What makes your agent feel like a real being:

- **Personal Mission** - Their burning life purpose
- **Active Project** - What they're currently working on
- **Secret Ambition** - Hidden dream they're pursuing
- **Core Values** - Unshakeable beliefs that guide them
- **Legacy Aspiration** - How they want to be remembered
- **Growth Challenge** - Personal struggle they're working through

### Enhanced Personality (Optional)

Fine-tune communication and behavior:

- **Emotional Intelligence** - How they process emotions
- **Communication Pattern** - Conversation structure style
- **Memory Style** - How they process and recall information
- **Energy Level** - Pacing and enthusiasm
- **Cultural Flavor** - Background influences
- **Humor Style** - Type of humor used
- **Backstory** - Personal history
- **Problem Solving** - Approach to challenges

---

## Capabilities & Behavior

### Response Styles

Choose how your agent communicates:

| Style | Description |
|-------|-------------|
| **Friendly** | Warm and approachable (default) |
| **Formal** | Professional and structured |
| **Casual** | Relaxed and conversational |
| **Technical** | Precise and detailed |
| **Playful** | Fun and energetic |
| **Concise** | Brief and to the point |
| **Detailed** | Comprehensive and thorough |

### Special Behaviors

Add custom tags that define specific behaviors your agent should exhibit. These are free-form and can be anything relevant to your use case.

---

## Identity Settings

### Gender & Pronouns

Configure how your agent identifies:

- **Gender options:** Male, Female, Non-binary, Agender, Genderfluid, Other, Prefer not to say
- **Pronouns:** Automatically set based on gender, or customize:
  - Subject (they, he, she, xe)
  - Object (them, him, her, xem)
  - Possessive (their, his, her, xir)
  - Reflexive (themselves, himself, herself, xemself)
- **Custom Pronouns:** Free-text field for any pronoun set

---

## System Prompt

The system prompt provides detailed instructions for how your agent should behave with AI.

### Writing System Prompts

- Describe the agent's role and expertise
- Set boundaries and guidelines
- Include specific instructions for common scenarios
- Reference personality traits for consistency

### Auto-Generation

Click **Generate** to have AI create a system prompt based on:
- Agent name and description
- Personality configuration
- Capabilities and response style

---

## AI-Powered Generation

Use AI to help create and enhance your agent:

### Generate Description
Auto-create a description from the agent's name.

### Generate Avatar
Create a portrait image based on:
- Agent personality
- Selected visual style
- Custom generation prompt

### Enhance Fields
Use the magic wand icon on any personality field to get AI suggestions.

### Randomize Personality
Generate random personality traits for inspiration.

---

## Using Agents in Sessions

### Activating Agents

1. **Agents button** - Click the **Agents** button in the chat footer toolbar (next to Smart Tools) to open the agents panel and toggle agents on or off for the current session
2. **Trigger Words** - Type `@agentname` in your message to invoke a specific agent
3. **Attach to Session** - Add agents via AI Settings
4. **Proactive Mode** - Enable agents to message automatically

### Proactive Messaging

Configure agents to proactively contribute:

- **Active Hours** - Set when agent can send messages
- **Timezone** - Specify your timezone
- **Minimum Interval** - Time between proactive messages
- **Custom Prompt** - Override system prompt for proactive context

### Multiple Agents

You can have multiple agents active in a session:
- Each responds to their trigger words
- Agents can work together on complex tasks
- Use different agents for different expertise areas

---

## Credit Management

### Credit Models

Agents can use credits in two ways:

1. **User Credits** - Uses your account's credit balance
2. **Agent Credits** - Agent has its own credit pool

### Managing Credits

- **Transfer Credits** - Move credits between your account and agent
- **Low Credit Warning** - Alerts when credits drop below 1000
- **Credit Display** - See credit balance on agent cards

---

## Sharing Agents

### Making Agents Public

Toggle **Public** to share your agent with all users:
- Anyone can use public agents
- Only you can edit or delete
- Great for team-wide assistants

### Private Agents

Private agents are only visible to:
- You (the creator)
- Users you explicitly share with

---

## Agent Gallery

### Browsing Agents

On the `/agents` page:
- **Search** - Find agents by name or description
- **Sort** - By name, date created, or popularity
- **Filter** - Your agents, public agents, shared with you

### Agent Cards

Each card shows:
- Avatar and name
- Description preview
- Credit balance
- Quick actions (edit, delete, share)

---

## Tips & Best Practices

### Creating Effective Agents

1. **Clear purpose** - Define what your agent excels at
2. **Consistent personality** - All dimensions should align
3. **Specific triggers** - Use unique, memorable trigger words
4. **Detailed system prompt** - More detail = better behavior

### Personality Design

1. **Start simple** - Core personality is often enough
2. **Add depth gradually** - Layer in agency and enhanced traits
3. **Test and iterate** - Try the agent and refine
4. **Use generation** - AI can spark creative ideas

### For Teams

1. **Create shared agents** - Public agents for common tasks
2. **Document usage** - Include instructions in description
3. **Standardize triggers** - Team-wide naming conventions

---

## Examples

### Research Assistant

```
Name: Research Assistant
Triggers: @research, @investigate
Major Motivation: Finding accurate, relevant information
Quirk: Always cites sources and asks clarifying questions
Response Style: Detailed
```

### Code Reviewer

```
Name: Code Reviewer
Triggers: @review, @codereview
Major Motivation: Improving code quality and teaching best practices
Flaw: Sometimes too nitpicky on style
Response Style: Technical
```

### Creative Writer

```
Name: Muse
Triggers: @muse, @creative
Major Motivation: Inspiring creativity and exploring ideas
Quirk: Speaks in metaphors and vivid imagery
Response Style: Playful
```

---

## Related Features

- [Notebooks](./notebooks.md) - Use agents in conversations
- [Smart Tools](./smart-tools.md) - Tools available alongside agents in the chat footer
- [Projects](./projects.md) - Associate agents with projects
- [Quest Master](./quest-master.md) - Agents in complex workflows
- [Subagents](./subagents.md) - Specialized CLI subagents for code exploration, planning, and review
