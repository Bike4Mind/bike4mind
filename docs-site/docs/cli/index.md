---
title: B4M CLI Overview
description: Interactive command-line interface for Bike4Mind with AI-powered agents
sidebar_position: 1
---

# B4M CLI Overview

The **B4M CLI** (`@bike4mind/cli`) is an interactive command-line interface that brings the power of Bike4Mind's AI agents directly into your terminal.

## What is B4M CLI?

B4M CLI is a terminal-based AI assistant that helps you accomplish tasks through natural conversation. It combines the power of large language models with an extensive suite of tools, allowing you to get work done without leaving your terminal.

**Think of it as:** Having an AI pair programmer, research assistant, and task automation tool—all in one command-line interface.

## Key Features

### 🤖 ReAct Agent with Tool Use
- Intelligent reasoning and planning
- Automatic tool selection and execution
- Context-aware decision making
- Multi-step task completion

### 💬 Interactive Chat Interface
- Natural conversation with AI
- Real-time streaming responses
- Rich terminal UI with colors and formatting
- Thought process visualization

### 💾 Session Management
- Save and resume conversations
- Full history preservation
- Token usage tracking
- Session organization

### 🛠️ Extensive Tool Suite
Built-in tools for common tasks:
- **File Operations**: Read, create, edit, search, and manage files
- **Web**: Search the web for information
- **Weather**: Real-time weather data (worldwide)
- **Math & Logic**: Calculations, dice rolls
- **Date/Time**: Current datetime information
- **Shell**: Execute bash commands

### 🔌 MCP Integration
- Model Context Protocol support
- GitHub, LinkedIn, Atlassian integrations
- Custom MCP server support
- Docker and Node.js execution options

### 🎨 Rich Terminal Experience
- Built with React (via Ink framework)
- Syntax highlighting for code
- Diff previews for file changes
- Image rendering in terminal
- Status indicators and spinners

### 📄 Context File Support
- Automatic loading of project instructions
- Support for `CLAUDE.md`, `AGENTS.md`, `AI.md`
- Global and project-level configurations
- Compatible with Claude Code standards

### 🔒 Security & Permissions
- OAuth authentication
- Tool permission management
- Trusted tool lists
- API key isolation

### 🛡️ Sandbox Isolation
- OS-level filesystem and network isolation for bash commands
- macOS Seatbelt and Linux Bubblewrap runtimes
- Network domain filtering via HTTP proxy
- Violation logging and monitoring

### 🐛 Debug & Logging
- Automatic debug logs to file
- Optional verbose console output
- Session replay capability
- Error tracking and diagnostics

## Why Use B4M CLI?

### For Developers
- Stay in your terminal workflow
- Automate repetitive tasks
- Get coding help without context switching
- Integrate with your existing tools

### For Researchers
- Quick information lookup
- Deep research capabilities
- Citation tracking
- Knowledge synthesis

### For Power Users
- Command-line efficiency
- Scriptable interactions
- Session persistence
- Customizable workflows

## What Makes B4M CLI Different?

**Self-hosted Options**: Connect to your organization's private Bike4Mind instance for data sovereignty.

**Extensible Architecture**: Add your own tools through MCP servers or custom integrations.

**Context-Aware**: Automatically loads project-specific instructions from context files.

**Transparent Reasoning**: See the agent's thought process in real-time with the thinking stream.

**Permission Control**: Fine-grained control over which tools can execute automatically vs. requiring approval.

## Quick Start

Get started in 30 seconds:

```bash
# Install globally
npm install -g @bike4mind/cli

# Run it
b4m

# Or run without installing
npx @bike4mind/cli
```

On first run, you'll authenticate with your Bike4Mind account via OAuth, and you're ready to go!

## Example Interactions

```bash
# Ask questions
> What's the weather in San Francisco?

# Run shell commands
> List all TypeScript files in this project

# Get coding help
> How do I implement rate limiting in Express.js?

# Research topics
> Deep research on quantum computing applications

# Manage sessions
/sessions        # List all saved sessions
/save my-work    # Save current conversation
```

## Platform Support

- **macOS**: Full support (arm64, x64)
- **Linux**: Full support (glibc 2.28+)
- **Windows**: Full support (WSL recommended for best experience)

**Requirements:**
- Node.js 24 or higher
- Terminal with 256 color support (recommended)
- Active internet connection for cloud features

## Architecture

B4M CLI is built with:
- **UI Framework**: [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- **Language**: TypeScript (ESM)
- **State Management**: Zustand
- **LLM Integration**: Supports Anthropic, OpenAI, Google AI, Ollama
- **Tool Protocol**: MCP (Model Context Protocol)

## Next Steps

<div class="button-group">

[Get Started →](/cli/getting-started)
*Installation and first run*

[Commands Reference →](/cli/commands)
*All available commands*

[Configuration →](/cli/configuration)
*Customize your setup*

[Sandbox →](/cli/sandbox)
*Secure command isolation*

[Examples →](/cli/examples)
*Real-world use cases*

</div>

## Community & Support

- **Issues**: [GitHub Issues](https://github.com/bike4mind/bike4mind/issues)
- **Documentation**: [B4M Docs](https://docs.bike4mind.com)
- **Web App**: [app.bike4mind.com](https://app.bike4mind.com)

---

**Ready to get started?** Continue to the [Getting Started Guide →](/cli/getting-started)
