---
title: Local Model Commands
description: Find, download, run and remove local models on Ollama with b4m models, including the fit check, --force, resuming a pull, and the MCP models_pull tool
sidebar_position: 13
---

# Local Model Commands

`b4m models` finds GGUF builds on Hugging Face, downloads them (or Ollama library models) into Ollama, makes one the model the CLI chats with, and removes them again. It needs a running [Ollama](https://ollama.com). To chat with an Ollama host's models without managing them, see [Self-hosted Ollama](./local-models.md).

| Command | What it does |
|---------|--------------|
| `b4m models ls` | List the models installed on Ollama |
| `b4m models search <terms>` | Search Hugging Face for GGUF repos |
| `b4m models show <owner/repo>` | List a repo's builds with size, fit and the ref to pull |
| `b4m models pull <ref>` | Download a model after showing its size, license and fit |
| `b4m models use <name>` | Make an installed model the CLI's default |
| `b4m models rm <name>` | Remove an installed model |
| `b4m models servers` | List the model servers saved in Desktop, with status |
| `b4m models servers login <name>` | Give the CLI its own credential for a server |
| `b4m models servers logout <name>` | Remove the CLI's credential for a server |

`ls`, `search`, `show` and `servers` print JSON with `--output-format json`. `ls`, `use`, `pull` and `rm` take `--server <name>` to act on a [Desktop model server](../features/desktop-model-servers.md) instead of the local Ollama.

## Pick and download a model

Search Hugging Face, then look at one repo's builds:

```bash
b4m models search smollm2 135m
b4m models show bartowski/SmolLM2-135M-Instruct-GGUF
```

`show` lists every build, smallest first, with a fit rating for your machine and the ref to pull:

```text
Builds (smallest first):
  BUILD     SIZE    FIT   OLLAMA REF
  IQ3_XS    88 MB   fits  hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:IQ3_XS
  ...
  Q4_K_M    105 MB  fits  hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M
  ...
  Fit is a rough estimate from each file's size for this machine (no GPU, 67.3 GB RAM); pull explains it.

Pull one with: b4m models pull bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M
```

Pull a Hugging Face build as `owner/repo:quant` (Q4_K_M when you leave the quant out), or an Ollama library model by name:

```bash
b4m models pull bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M
b4m models pull smollm2:135m
```

Nothing downloads without your confirmation. `pull` prints the size, license and fit first, then asks `Download 271 MB? [y/N]`. `--yes` skips that question. A license that is not a permissive open-source one, or no declared license, is named with a link and must be accepted at a prompt or with `--accept-license`.

```text
Model:    smollm2:135m (Ollama registry)
Digest:   9077fe9d2ae1
Size:     271 MB
License:  Apache-2.0
Runtime:  Ollama at http://127.0.0.1:11434
Fit:      fits. Rough estimate from the file size: about 490 MB before context memory, at up to the 32K context the CLI requests, of the 50.5 GB a model can use in RAM here.
```

## Check whether a model fits

Every build is rated for the machine Ollama runs on:

- `fits`: the file and its working memory fit with room left for context.
- `tight`: it fits with little room to spare, or part of it runs from system RAM and replies are slower.
- `too large`: it does not fit in the memory a model can use here.
- `unknown`: the CLI cannot read the machine's memory, Ollama runs on another machine, or Hugging Face does not report the size of the build or its vision projector.

The rating is a rough estimate from the file size, at the context the CLI asks Ollama for: the model's trained length capped at 32K tokens, or at `OLLAMA_MAX_NUM_CTX` when you set it.

`pull` refuses a too-large build before asking anything:

```text
Fit:      too large. Rough estimate from the file size: about 50.8 GB before context memory, at the 32K context the CLI requests; with 268 MB reserved headroom, this exceeds the 50.5 GB a model can use in RAM here.
Error: Nothing was downloaded: this build is rated too large for this machine. Pick a smaller quant from: b4m models show bartowski/Llama-3.3-70B-Instruct-GGUF, or re-run with --force to download it anyway.
```

Pick a smaller quant from `show`, or add `--force` to download it anyway. `--force` skips only the fit check: the license and download prompts still apply. A `tight` or `unknown` rating never blocks a pull.

## Resume an interrupted pull

Ctrl-C cancels a pull without installing anything:

```text
Pull cancelled. Nothing was installed; Ollama keeps the partial download, so pulling again resumes it.
```

Run the same `pull` again to resume. The CLI says how much was already on disk:

```text
pulling manifest
Already downloaded: 27 MB; pulling the rest.
...
Pulled smollm2:135m. Chat with it by default: b4m models use smollm2:135m
```

## Chat with a local model

```bash
b4m models use smollm2:135m
```

```text
Default model: smollm2:135m on Ollama at http://127.0.0.1:11434
Start chatting with: b4m
```

`b4m`, `b4m -p` and the other CLI surfaces all use this one default model. `b4m models ls` marks it `default`.

## Remove a model

```bash
b4m models rm smollm2:135m
```

`rm` asks first; `--yes` skips the question. If the model was your default, the CLI says so and you pick another with `b4m models use`.

## Use an Ollama on another machine

Without a saved host, `b4m models` uses the first local runtime it finds. To use a specific Ollama, pass `--ollama-host` once; a host that answers is saved for later commands:

```bash
b4m models ls --ollama-host http://gpu-box.example.com:11434
```

`B4M_OLLAMA_HOST` overrides the saved host.

The CLI cannot read another machine's memory, so builds on a remote host are rated `unknown` and never blocked:

```text
Fit is unknown. Ollama at http://gpu-box.example.com:11434 runs on another machine, whose memory this one cannot read.
```

An Ollama reached through an SSH tunnel looks local, so it is rated as the machine you run the CLI on:

```bash
ssh -N -L 11500:127.0.0.1:11434 user@gpu-box.example.com
b4m models ls --ollama-host http://127.0.0.1:11500
```

If the far machine has more memory than yours, add `--force` to pull a build rated too large.

## Use the model servers saved in Desktop

The CLI reads the server list you keep in Desktop (Settings > Model servers). It never changes that list. `b4m models servers` shows each server with its kind, address, access, whether the CLI has a credential for it, and whether it answers:

```bash
b4m models servers
```

```text
NAME     KIND    ADDRESS                          ACCESS     CREDENTIALS                              STATUS
shared   Ollama  http://127.0.0.1:11434           Manage     none                                     online (4 ms)
vllm     vLLM    http://127.0.0.1:8001            Chat only  none                                     online (6 ms)
gpu-box  Ollama  https://gpu-box.example.com      Manage     needed: b4m models servers login gpu-box  needs credentials
```

The NOTE column warns when a server uses plain http on a private network ("Unencrypted") and when a public server answers anyone without credentials ("Open to anyone"). Add `--check-tools` to send each OpenAI-compatible server a one-token request that declares a tool; a server that refuses tool calls gets a note saying what to change on it.

Desktop keeps its credentials in your operating system's encrypted storage, which the CLI cannot read. For a server that needs one, type it once for the CLI. The input is hidden, and the CLI saves it only after the server accepts it:

```bash
b4m models servers login gpu-box
```

Pipe the credential instead with `--token-stdin`. The CLI keeps its copy in `~/.bike4mind/config.json`, which only you can read, next to its own sign-in tokens. It never prints a credential. `b4m models servers logout gpu-box` removes it, and also accepts the raw server id to clear a credential whose server was deleted in Desktop. The same address rules as in Desktop apply: credentials go over https, or over http only to this computer or a Tailscale address.

Add `--server <name>` to act on one of these servers:

```bash
b4m models ls --server vllm
```

On an OpenAI-compatible server such as vLLM, `ls` shows each model once with its context length, the other names it answers to, and a LoRA adapter's base model. Chatting with a model on one of these servers is not available in the CLI yet, so `use --server` refuses and saves nothing. `pull` and `rm` work only on an Ollama server that Desktop lets you manage. A server set to Chat only in Desktop, and servers such as vLLM that serve a fixed set of models, refuse them. A pull still shows the size and license and asks first.

## Manage models from an MCP client

When the CLI runs as an MCP server (`b4m mcp serve`), it offers `models_list`, `models_search`, `models_pull` and `models_remove` with the same checks. The host comes from `B4M_OLLAMA_HOST`, the saved host, or detection, as for `b4m models`. `models_list`, `models_pull` and `models_remove` also take a `server` argument naming a Desktop model server, with the same credentials and the same pull and remove limits.

`models_pull` never downloads on its own. A client that supports elicitation asks you directly, showing the size, every license and the fit. Any other client gets the preview and a command to run in your terminal, where the CLI asks you:

```json
{
  "status": "confirm-in-terminal",
  "downloaded": false,
  "model": "smollm2:135m",
  "size": "271 MB",
  "fit": {
    "verdict": "fits",
    "detail": "Rough estimate from the file size: about 490 MB before context memory, at up to the 32K context the CLI requests, of the 50.5 GB a model can use in RAM here."
  },
  "command": "B4M_OLLAMA_HOST=http://127.0.0.1:11434 b4m models pull smollm2:135m"
}
```

A model rated too large returns `"status": "too-large"` and nothing is downloaded. The client can call again with `force: true` if you ask for it anyway. That only lets the request reach you: you still approve the download, and the terminal command it returns includes `--force`.

## See also

- [Self-hosted Ollama](./local-models.md) - chat with an Ollama host's models from the picker
- [Configuration](./configuration.md) - where the CLI keeps its settings
