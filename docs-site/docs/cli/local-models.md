---
title: Self-hosted Ollama
description: Connect B4M CLI to a self-hosted Ollama endpoint — local, remote, or B4M-hosted
sidebar_position: 12
---

# Self-hosted Ollama

The B4M CLI can connect to any [Ollama](https://ollama.com) endpoint via `--ollama-host`. Models
from that endpoint appear in the model picker alongside your B4M cloud models, and you can switch
between them mid-session.

"Self-hosted" here means you point the CLI at a specific Ollama host — it can be:

- **Your machine** — for privacy or offline use
- **A remote server or EC2 instance** — shared inference across a team
- **B4M-hosted Ollama** — when B4M's own API surfaces Ollama models

---

## Connecting to an Ollama endpoint

```bash
b4m --ollama-host <url>
```

On startup you'll see:

```
🦙 Ollama connected: 2 model(s) added to picker
```

Open the model picker (`/model`) to see both B4M cloud models and Ollama models listed together.
Select any model to switch — mid-session switching is fully supported.

### Examples

```bash
# Ollama running on your machine (default port)
b4m --ollama-host http://localhost:11434

# Ollama on a remote host
b4m --ollama-host http://192.168.1.50:11434

# Ollama with basic auth
b4m --ollama-host http://user:password@ollama.internal:11434
```

---

## Running Ollama yourself

If you want to host your own Ollama instance:

**Install:**

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows:** Download from [ollama.com/download](https://ollama.com/download).

**Start:**

```bash
ollama serve   # Linux / manual start
# macOS: starts automatically after install
```

**Pull a model:**

```bash
ollama pull qwen3.5        # recommended (9b, ~7 GB RAM)
ollama pull qwen3.5:4b     # lighter option (~3 GB RAM)
ollama pull qwen3.5:27b    # higher quality (~17 GB RAM)
```

[Qwen3.5](https://ollama.com/library/qwen3.5) is the recommended model family for use with the
B4M CLI. It is specifically optimized for tool calling and reasoning, which maps well to how the
CLI's ReAct agent uses tools.

---

## Limitations

- **Tool calling performance** — The CLI passes tool schemas to Ollama natively, which can add
  significant input tokens (~50 K for a typical session). Larger models on slower hardware may
  take a minute or more to respond. Using `qwen3.5:4b` or `qwen3.5:9b` gives the best balance of
  speed and capability.
- **Quality** — Open-source models generally produce lower-quality output than frontier cloud
  models for complex reasoning tasks.
- **Context window** — Reported as 8 192 tokens regardless of actual model capacity. This will be
  improved in a future release.

---

## See Also

- [Features Guide →](/cli/features) — full B4M CLI capabilities
- [Configuration →](/cli/configuration) — persistent settings
- [Troubleshooting →](/cli/troubleshooting) — common issues
