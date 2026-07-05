---
title: Smart Tools
description: AI-powered tools available in your chat sessions for web search, image generation, data visualization, and more
sidebar_position: 6
tags: [tools, chat, capabilities, core-feature]
---

# Smart Tools

Bike4Mind equips your AI conversations with a set of smart tools that extend what the AI can do beyond generating text. When tools are enabled in a notebook, the AI can search the web, generate images, create charts, perform calculations, and more — all inline within your conversation.

> **Tool Availability:** Some tools may be enabled or disabled at the organizational level by your administrator. If a tool you expect to see is not available, contact your organization administrator.

## Enabling Tools

Tools are managed per-notebook. You can toggle them from either of two surfaces — both edit the same per-notebook state:

- **Smart Tools dropdown in the composer** (recommended) — click the **Smart Tools** button next to the message input. The dropdown shows the catalog inline and is the fastest way to toggle tools while you're chatting.
- **AI Settings panel** — open a notebook, click the **AI Settings** panel, and scroll to the **Tools** section.

### Smart vs Fast mode

The composer dropdown also exposes a **Smart / Fast** toggle:

- **Smart** — the AI uses any enabled tools as needed. Leave a tool on to make it available; toggle one off to disallow it for this conversation. This is the default.
- **Fast** — no tools are used. The AI replies as quickly as possible using only its base model.

You can also explicitly ask the AI to use a specific tool (e.g., "search the web for..." or "generate an image of...").

---

## Web & Research Tools

### Web Search

Search the web using Google Search to find current information on any topic. The AI will present results with source links so you can verify information.

**Example prompts:**
- "What are the latest developments in renewable energy?"
- "Search for React 19 release notes"

### Web Fetch

Fetch and read the full content of a specific URL. Give the AI a link and it will retrieve and summarize the page content.

**Example prompts:**
- "Read this article and summarize it: https://example.com/article"
- "What does this page say? https://docs.example.com/guide"

### Deep Research

Conduct comprehensive multi-step research on a topic. The AI performs iterative web searches, gathers information from multiple sources, and synthesizes findings into a thorough report.

**Example prompts:**
- "Do a deep research report on the state of AI regulation in the EU"
- "Research the pros and cons of microservices vs monolith architectures"

### Knowledge Base Search

Search your uploaded documents in the Knowledge Base. The AI can find and reference content from your personal files, organization-shared documents, and files shared with you.

**Example prompts:**
- "Search my knowledge base for the Q3 report"
- "What do my uploaded documents say about the deployment process?"

---

## Creative Tools

### Image Generation

Generate images from text descriptions using multiple AI image models (FLUX, GPT-Image, Gemini, Grok). See [Image Generation](./image-processing-generation.md) for full details on available models and options.

**Example prompts:**
- "Generate an image of a sunset over a mountain lake"
- "Create a logo design for a coffee shop called 'Bean There'"

### Image Editing

Edit and modify existing images based on text instructions. Upload an image and describe the changes you want — remove backgrounds, change colors, add or remove objects, and more.

**Example prompts:**
- "Remove the background from this image"
- "Change the sky to a sunset in this photo"

### Prompt Enhancement

Automatically optimize your image generation prompts for better results. When enabled, your descriptions are refined before being sent to the image model.

---

## Data & Visualization Tools

### Charts (Recharts)

Generate interactive data visualizations directly in your conversation. Supports line charts, bar charts, pie charts, area charts, scatter plots, radar charts, treemaps, funnel charts, and composed charts.

**Example prompts:**
- "Create a bar chart comparing Q1-Q4 revenue: Q1=$1.2M, Q2=$1.5M, Q3=$1.8M, Q4=$2.1M"
- "Make a pie chart of our market share breakdown"

### Mermaid Diagrams

Generate diagrams using Mermaid syntax — flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams, Gantt charts, and more. Diagrams render visually inline in the conversation.

**Example prompts:**
- "Draw a flowchart of the user login process"
- "Create a sequence diagram showing the API request lifecycle"

### Math Evaluation

Evaluate mathematical expressions using advanced math syntax. Supports arithmetic, algebra, trigonometry, calculus, and statistics.

**Example prompts:**
- "Calculate the compound interest on $10,000 at 5% for 10 years"
- "What is the integral of x^2 from 0 to 5?"

---

## Utility Tools

### Current Date & Time

Get the current date and time in any timezone, perform date calculations (days until/since a date), and look up what day of the week a historical date fell on.

**Example prompts:**
- "What time is it in Tokyo right now?"
- "How many days until December 25?"

### Weather

Get current weather conditions for any location using latitude and longitude coordinates.

**Example prompts:**
- "What's the weather like in San Francisco?"
- "Get the current temperature in London"

### Dice Roll

Roll dice with any number of sides — useful for games, random selection, or probability demonstrations.

---

## Astronomy Tools

### Moon Phase

Get the current moon phase with illumination percentage, moon age, traditional moon names, and upcoming lunar phase predictions.

### Sunrise & Sunset

Calculate sunrise, sunset, twilight times, golden hour, and day length for any location. Also shows whether days are getting longer or shorter.

### ISS Tracker

Track the International Space Station in real-time. See its current position or find out who is currently aboard the ISS and other spacecraft.

### Planet Visibility

Check which of the 5 naked-eye planets (Mercury, Venus, Mars, Jupiter, Saturn) are visible tonight, their positions, and rise/set times.

---

## Content & Publishing Tools

### Blog Draft

Transform conversation content into a structured blog post draft. The AI formats your content with a title, summary, tags, and body text, then presents a preview card for you to review before publishing.

### Blog Publish

Publish a finalized blog post directly to your configured blog platform. Typically used after reviewing a draft created by the Blog Draft tool.

### Blog Edit

Edit an existing blog post — update content, change status between draft and published, or modify any post fields.

### File Editing

Edit file content using natural language instructions. Describe the changes you want and the AI will apply them.

---

## Optimization Tools

### Schedule Optimization

Run optimization solvers on scheduling problems to find optimal or near-optimal schedules using a range of optimization solvers. See OptiHashi for the full optimization dashboard.

### Problem Formulation

Convert natural language descriptions of scheduling problems into structured input that the scheduler can solve. Describe your problem in plain English and the AI will formulate it.

---

## Navigation

### Navigate View

The AI can suggest navigation to relevant pages within Bike4Mind based on the conversation topic. Clickable action buttons appear inline so you can jump to the relevant feature.

---

## External Integrations (MCP Tools)

When you connect external services, additional tools become available in your chat sessions:

### Atlassian (Jira & Confluence)

After connecting your Atlassian account in [Settings > Connected Apps](./profile-settings.md#connected-apps), you can:
- Search and view Jira issues
- Create and update Jira tickets
- Search Confluence pages
- Reference project documentation

### GitHub

After connecting GitHub, you can:
- Search repositories and issues
- Reference pull requests and code

> If an external tool reports a connection error (e.g., "connection expired"), visit **Settings > Connected Apps** to reconnect the service.

---

## Tips & Best Practices

### Getting the Best Results

1. **Be explicit** — If you want a specific tool used, mention it: "search the web for..." or "create a chart showing..."
2. **Combine tools** — The AI can use multiple tools in a single response (e.g., search the web, then create a chart from the data)
3. **Iterate** — If a chart or image isn't quite right, ask for adjustments
4. **Provide data** — For charts and visualizations, provide specific numbers for best results

### Managing Tool Usage

- Tools that call external services (web search, deep research) may use additional credits
- Disable tools you don't need to keep the AI focused on text generation
- Image generation uses separate credit pricing per model

---

## Related Features

- [Notebooks](./notebooks.md) - Where you use tools in conversations
- [AI Models](./ai-models.md) - Models that power tool responses
- [Image Generation](./image-processing-generation.md) - Detailed image model guide
- [Knowledge Management](./knowledge-management.md) - Your document knowledge base
- [Research Mode](./research-mode.md) - Compare multiple models side-by-side
