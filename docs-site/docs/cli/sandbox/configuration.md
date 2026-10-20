---
title: Sandbox Configuration
description: Configure filesystem isolation, network filtering, and platform settings
sidebar_position: 3
tags: [configuration, reference, sandbox]
---

# Sandbox Configuration

The sandbox is configured through JSON config files with a 3-layer merge system. This page documents the full config schema and provides practical examples.

## Config File Locations

| Scope | Path | Shared? | Use Case |
|-------|------|---------|----------|
| Global | `~/.bike4mind/config.json` | Per-user | Personal defaults |
| Project | `.bike4mind/config.json` | Git-committed | Team-wide settings |
| Local | `.bike4mind/local.json` | Gitignored | Personal overrides |

**Merge order:** Global → Project → Local. Later files override earlier ones via deep merge. Arrays are **replaced**, not concatenated — if the local config defines `allowedDomains`, it fully replaces the project config's list.

## Full Schema

```json
{
  "sandbox": {
    "enabled": false,
    "mode": "disabled",
    "filesystem": {
      "writeOnlyToWorkingDir": true,
      "allowedReadPaths": [
        "$HOME/.gitconfig",
        "$HOME/.npmrc",
        "$HOME/.node_modules"
      ],
      "deniedPaths": [
        "$HOME/.ssh",
        "$HOME/.aws",
        "$HOME/.gnupg",
        "$HOME/.env",
        "/etc/shadow",
        "/etc/passwd"
      ]
    },
    "network": {
      "enabled": false,
      "allowedDomains": [
        "registry.npmjs.org",
        "*.npmjs.org",
        "pypi.org",
        "*.pypi.org",
        "files.pythonhosted.org",
        "crates.io",
        "*.crates.io",
        "rubygems.org",
        "github.com",
        "*.github.com",
        "gitlab.com",
        "*.gitlab.com",
        "bitbucket.org",
        "*.bitbucket.org",
        "*.githubusercontent.com",
        "*.cloudflare.com"
      ]
    },
    "excludedCommands": ["docker", "watchman", "podman"],
    "allowUnsandboxedCommands": true,
    "platform": {
      "linux": { "runtime": "bubblewrap" },
      "macos": { "runtime": "seatbelt", "profileTemplate": "default" }
    }
  }
}
```

## Filesystem Configuration

### `writeOnlyToWorkingDir`

**Type:** `boolean` | **Default:** `true`

When `true`, the sandbox restricts file writes to:
- Your current working directory (and subdirectories)
- `/tmp` and system temp directories

All other write paths are denied at the OS level.

### `allowedReadPaths`

**Type:** `string[]` | **Default:** `["$HOME/.gitconfig", "$HOME/.npmrc", "$HOME/.node_modules"]`

Paths the sandbox allows reading. These override the default read restrictions to let tools access common configuration files.

Supports [path variable expansion](#path-variable-expansion).

### `deniedPaths`

**Type:** `string[]` | **Default:** `["$HOME/.ssh", "$HOME/.aws", "$HOME/.gnupg", "$HOME/.env", "/etc/shadow", "/etc/passwd"]`

Paths blocked for both read and write access. These are enforced at the OS level — even if a command tries to read `~/.ssh/id_rsa`, the sandbox runtime will deny it.

Supports [path variable expansion](#path-variable-expansion).

:::tip
On macOS (Seatbelt), denied paths generate `deny(N)` messages in stderr that the CLI captures as violations. On Linux (Bubblewrap), denied paths are hidden behind empty `tmpfs` mounts.
:::

## Network Configuration

### `enabled`

**Type:** `boolean` | **Default:** `false`

Must be `true` for the network proxy to start. When disabled, sandboxed commands have unrestricted network access.

### `allowedDomains`

**Type:** `string[]` | **Default:** (see full schema above)

Domains that the proxy allows connections to. Two matching modes:

- **Exact match:** `github.com` — matches only `github.com`
- **Wildcard:** `*.github.com` — matches `api.github.com`, `raw.github.com`, etc. but **not** the bare `github.com`

**Matching rules:**
- Case-insensitive (`GitHub.com` matches `github.com`)
- Port-stripped (`github.com:443` matches `github.com`)
- Trailing dots are normalized

**Default allowlist** covers common package registries and code hosting:
- **npm:** `registry.npmjs.org`, `*.npmjs.org`
- **PyPI:** `pypi.org`, `*.pypi.org`, `files.pythonhosted.org`
- **Cargo:** `crates.io`, `*.crates.io`
- **RubyGems:** `rubygems.org`
- **GitHub:** `github.com`, `*.github.com`, `*.githubusercontent.com`
- **GitLab:** `gitlab.com`, `*.gitlab.com`
- **Bitbucket:** `bitbucket.org`, `*.bitbucket.org`
- **CDN:** `*.cloudflare.com`

## Excluded Commands

### `excludedCommands`

**Type:** `string[]` | **Default:** `["docker", "watchman", "podman"]`

Commands that bypass sandbox wrapping. These commands are incompatible with Seatbelt/Bubblewrap because they manage their own namespaces or filesystem mounts.

The sandbox extracts the base command name — `docker compose up` checks against `docker`, and `/usr/bin/docker` checks against `docker`.

### `allowUnsandboxedCommands`

**Type:** `boolean` | **Default:** `true`

Controls what happens when an excluded command is executed:

- **`true`** — Excluded commands run unsandboxed (with normal permission prompts)
- **`false`** — Excluded commands are **blocked entirely** and recorded as violations

Set to `false` for maximum security when you want to prevent any unsandboxed execution.

## Platform Configuration

### `platform.macos`

- `runtime`: `"seatbelt"` — Uses macOS `sandbox-exec` with generated Seatbelt profiles
- `profileTemplate`: `"default"` — Profile template to use

### `platform.linux`

- `runtime`: `"bubblewrap"` — Uses `bwrap` with namespace isolation

Platform config is rarely changed. The sandbox auto-detects your platform and uses the appropriate runtime.

## Path Variable Expansion

The following variables are expanded in `allowedReadPaths` and `deniedPaths`:

| Variable | Expands to | Example |
|----------|-----------|---------|
| `$HOME` | User home directory | `/Users/alice` |
| `$USER` | Username | `alice` |
| `~/` | User home directory (prefix only) | `/Users/alice/` |

## Example Configurations

### Development (Recommended)

Sandbox enabled, network filtering off. Good for everyday development where you want filesystem protection without network restrictions.

```json
{
  "sandbox": {
    "enabled": true,
    "mode": "auto-allow",
    "filesystem": {
      "writeOnlyToWorkingDir": true,
      "allowedReadPaths": [
        "$HOME/.gitconfig",
        "$HOME/.npmrc",
        "$HOME/.node_modules",
        "$HOME/.cargo"
      ],
      "deniedPaths": [
        "$HOME/.ssh",
        "$HOME/.aws",
        "$HOME/.gnupg",
        "$HOME/.env"
      ]
    },
    "network": {
      "enabled": false
    }
  }
}
```

### Strict Security

Full sandbox with network filtering. Permissions mode requires approval for each command. Excluded commands are blocked entirely.

```json
{
  "sandbox": {
    "enabled": true,
    "mode": "permissions",
    "filesystem": {
      "writeOnlyToWorkingDir": true,
      "allowedReadPaths": ["$HOME/.gitconfig"],
      "deniedPaths": [
        "$HOME/.ssh",
        "$HOME/.aws",
        "$HOME/.gnupg",
        "$HOME/.env",
        "$HOME/.kube",
        "$HOME/.docker",
        "/etc/shadow",
        "/etc/passwd"
      ]
    },
    "network": {
      "enabled": true,
      "allowedDomains": [
        "registry.npmjs.org",
        "github.com",
        "*.github.com"
      ]
    },
    "excludedCommands": ["docker", "watchman", "podman"],
    "allowUnsandboxedCommands": false
  }
}
```

### Team Project Config

Shared `.bike4mind/config.json` committed to the repo. Sets baseline sandbox settings that all team members inherit.

```json
{
  "sandbox": {
    "enabled": true,
    "mode": "auto-allow",
    "filesystem": {
      "writeOnlyToWorkingDir": true,
      "allowedReadPaths": [
        "$HOME/.gitconfig",
        "$HOME/.npmrc"
      ],
      "deniedPaths": [
        "$HOME/.ssh",
        "$HOME/.aws",
        "$HOME/.gnupg",
        "$HOME/.env"
      ]
    },
    "network": {
      "enabled": true,
      "allowedDomains": [
        "registry.npmjs.org",
        "*.npmjs.org",
        "github.com",
        "*.github.com",
        "api.internal-service.company.com"
      ]
    }
  }
}
```

Individual developers can override in `.bike4mind/local.json` (gitignored):

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": [
        "registry.npmjs.org",
        "*.npmjs.org",
        "github.com",
        "*.github.com",
        "api.internal-service.company.com",
        "*.openai.com"
      ]
    }
  }
}
```

## See Also

- [Sandbox Overview](./index.md) — What the sandbox does and how it works
- [Commands Reference](./commands.md) — All sandbox slash commands
- [Troubleshooting](./troubleshooting.md) — Common issues and solutions
