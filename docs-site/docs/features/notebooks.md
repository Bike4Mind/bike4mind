---
title: Notebooks - AI Chat Sessions
description: Complete guide to Bike4Mind's notebook chat interface - your workspace for AI conversations
sidebar_position: 2
tags: [notebooks, chat, sessions, core-feature]
---

# Notebooks - AI Chat Sessions

Notebooks are the core of your Bike4Mind experience. Each notebook is a persistent conversation with AI that you can return to, search, and build upon over time.

## Getting Started

### Creating a New Notebook

1. Click **New** in the sidebar or press the new notebook button
2. Start typing your message in the input area
3. Press **Enter** to send (or **Shift+Enter** for a new line)

Your notebook is automatically saved and will appear in your sidebar for easy access.

### Navigating Your Notebooks

- **Sidebar** - All your notebooks appear in the left sidebar
- **Favorites** - Star important notebooks for quick access
- **Search** - Find notebooks by name or content
- **Projects** - Organize related notebooks into projects

---

## Input Options

### Text Input

The rich text editor supports:

- **Markdown formatting** - Bold, italic, lists, code blocks
- **Code highlighting** - Automatic syntax detection
- **Math equations** - LaTeX/KaTeX support
- **@mentions** - Reference agents with `@agent-name`

### File Attachments

Attach files to provide context for your conversation:

**Upload Methods:**
- Click the attachment button
- Drag and drop files into the chat
- Paste from clipboard
- Connect Google Drive for cloud files

**Supported File Types:**
- Documents: PDF, DOCX, TXT, MD, HTML
- Data: CSV, JSON, XLSX
- Images: PNG, JPG, GIF, WebP
- Code files: Most programming languages

### Image Input

Upload images for AI analysis:
- Single or multiple images per message
- Image preview with lightbox gallery
- AI can describe, analyze, and answer questions about images
- Image editing tools available for supported models

### Voice Input

Start a voice session for hands-free interaction:
- Real-time speech-to-text transcription
- Multiple voice options for AI responses
- Visual audio feedback while speaking
- Mute/unmute controls

---

## Working with Messages

### Message Actions

Every message has a menu with useful actions:

| Action | Description |
|--------|-------------|
| **Copy** | Copy the full response to clipboard |
| **Edit** | Modify and resend your prompt |
| **Pin** | Mark important messages for quick reference |
| **Delete** | Remove message from conversation |
| **Fork** | Create a new notebook branching from this point |
| **Download** | Save as Markdown, text, or PDF |

### Code Blocks

AI responses often include code with:
- Syntax highlighting for 100+ languages
- One-click copy button
- Expand for full-screen viewing

### Rich Content

Responses can include:
- **Diagrams** - Mermaid charts rendered visually
- **React components** - Interactive UI elements
- **Charts** - Data visualizations with Recharts
- **HTML/CSS** - Styled content previews

---

## AI Settings

Customize how AI responds in each notebook.

### Model Selection

Choose from multiple AI models across providers:

- **OpenAI** - GPT-5 family, GPT-4.1, O-series reasoning models
- **Anthropic** - Claude 4.6 Opus, Claude 4.5 Sonnet/Haiku, and more
- **Google** - Gemini 3, Gemini 2.5 Pro/Flash
- **xAI** - Grok 4, Grok 3 family
- **Open models** - Llama 4, DeepSeek, and more via AWS Bedrock

See [AI Models](./ai-models.md) for the full model guide. Filter models by type (Text, Image, Video), speed, or price tier.

### Temperature

Control response creativity:
- **0.0** - Focused, deterministic responses
- **0.7** - Balanced (recommended for most uses)
- **1.0+** - More creative, varied responses

### Context & Memory

- **History lines** - How much conversation context to include
- **Mementos** - AI remembers important details across sessions
- **Knowledge files** - Attach documents for reference

### Special Modes

- **Quest Master** - Break complex tasks into subtasks
- **Research Mode** - Compare multiple models simultaneously
- **Artifacts** - Enable rich interactive outputs

---

## Advanced Features

### Search Within Notebook

Use the search bar in the header to:
- Find specific messages by text
- Filter to show only pinned messages
- Navigate long conversation histories

### Layout Options

Customize your workspace:

| Layout | Best For |
|--------|----------|
| **Chat only** | Focused conversations |
| **Horizontal split** | Chat + knowledge viewer |
| **Vertical split** | Side-by-side comparison |
| **Picture-in-picture** | Multitasking |

### Agents

Attach specialized AI agents to your notebook:
- Each agent has a unique personality and expertise
- Mention agents with `@agent-name` in your messages
- Agents can proactively contribute to conversations

### Smart Tools

Your notebooks have access to a full suite of AI-powered tools that extend what the AI can do beyond text generation. Toggle between **Smart** mode (AI auto-selects the right tools) and **Fast** mode (no tools, fastest response).

Available tool categories include:
- **Web Search & Deep Research** - Find current information and conduct multi-step research
- **Knowledge Base Search** - Reference your uploaded documents
- **Image Generation & Editing** - Create and modify images
- **Charts & Diagrams** - Generate data visualizations and Mermaid diagrams
- **Math & Calculations** - Evaluate complex expressions
- **Astronomy** - Moon phases, sunrise/sunset, ISS tracking, planet visibility
- **Blog Publishing** - Draft, edit, and publish blog posts
- **External Integrations** - Atlassian (Jira/Confluence), GitHub, and other MCP tools

See [Smart Tools](./smart-tools.md) for the full guide on every available tool.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in message |
| `?` | Open Help Center |
| `@` | Mention an agent |

---

## Tips & Best Practices

### Writing Effective Prompts

1. **Be specific** - Clear instructions get better results
2. **Provide context** - Attach relevant files or explain background
3. **Iterate** - Use edit and retry to refine responses
4. **Use agents** - Specialized agents for specific tasks

### Organizing Your Work

1. **Use Projects** - Group related notebooks together
2. **Pin important messages** - Quick reference later
3. **Star favorites** - Access frequent notebooks quickly
4. **Download key responses** - Save important outputs

### Managing Long Conversations

1. **Fork** when starting a new direction
2. **Search** to find specific exchanges
3. **Pin** milestones and key decisions
4. **Create snippets** to preserve important context

---

## Troubleshooting

### Message Not Sending

- Check your internet connection
- Verify you have available credits
- Try refreshing the page

### Slow Responses

- Consider using a faster model
- Reduce the amount of context/history
- Check if complex tools are enabled

### File Upload Issues

- Verify file size is under limits
- Check file type is supported
- Try a different upload method

---

## Related Features

- [Smart Tools](./smart-tools.md) - All available AI tools
- [AI Models](./ai-models.md) - Model selection guide
- [Projects](./projects.md) - Organize notebooks
- [Agents](./agents.md) - Create custom AI assistants
- [Knowledge Management](./knowledge-management.md) - Manage documents
- [Quest Master](./quest-master.md) - Complex task planning
- [Mementos](./mementos.md) - AI memory system
