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
        "$HOME/.node_modules"
      ],
      "deniedPaths": [
        "$HOME/.ssh",
        "$HOME/.aws",
        "$HOME/.gnupg",
        "$HOME/.env",
        "$HOME/.claude",
        "$HOME/.bike4mind",
        "$HOME/.npmrc",
        "$HOME/.netrc",
        "$HOME/.config/gh",
        "$HOME/.docker",
        "$HOME/.kube",
        "$HOME/.config/gcloud",
        "$HOME/.azure",
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
    "allowContainerSockets": false,
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

All other write paths are denied at the OS level. The working directory's `.git` metadata and `.bike4mind` configuration remain read-only even when `writeOnlyToWorkingDir` is `false`. Run Git operations that update metadata, such as staging and committing, as trusted operations outside the sandbox.

### `allowedReadPaths`

**Type:** `string[]` | **Default:** `["$HOME/.gitconfig", "$HOME/.node_modules"]`

Paths the sandbox allows reading. Explicit `deniedPaths` entries take precedence over `allowedReadPaths`, including when an allowed path is nested inside a denied directory.

Supports [path variable expansion](#path-variable-expansion).

### `deniedPaths`

**Type:** `string[]` | **Default:** See the `deniedPaths` list in the [full schema](#full-schema).

Paths blocked for both read and write access. These are enforced at the OS level — even if a command tries to read `~/.ssh/id_rsa`, the sandbox runtime will deny it.

Supports [path variable expansion](#path-variable-expansion).

:::tip
On macOS (Seatbelt), access to denied paths is rejected. On Linux (Bubblewrap), denied directories are hidden behind empty `tmpfs` mounts and denied files are replaced by read-only empty files. Linux commands may report missing files or empty content rather than a permission error.
:::

## Network Configuration

### `enabled`

**Type:** `boolean` | **Default:** `false`

Must be `true` for the network proxy to start. When disabled, sandboxed commands have no network access (local Unix sockets still work).

On macOS the sandbox profile permits only loopback traffic, so direct connections to other hosts are blocked and outbound traffic to them has to go through the proxy. On Linux the command runs in its own network namespace with only a loopback interface, where a small relay forwards the proxy port to the CLI's proxy; direct connections and DNS lookups fail. Inside that namespace, `localhost` services on the host are not reachable. The relay is started with the same `node` binary that runs the CLI. Node's built-in `fetch` honors the proxy only on recent Node releases (24.3 and newer are known to work); on older versions it connects directly and fails inside the sandbox.

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

### `allowContainerSockets`

**Type:** `boolean` | **Default:** `false`

Sandboxed commands cannot connect to container engine API sockets. The blocked locations are:

- `/var/run/docker.sock` and `/run/docker.sock` (plus whatever file they link to)
- `/run/podman` and `$TMPDIR/podman`
- `~/.docker` (including Docker Desktop's `~/.docker/run` and `~/.docker/desktop`) and `~/Library/Containers/com.docker.docker/Data`
- `~/.colima`, `~/.lima`, `~/.rd`, `~/.orbstack` and `~/.local/share/containers`
- `$XDG_CONFIG_HOME/colima` (default `~/.config/colima`), `$COLIMA_HOME` and `$LIMA_HOME`
- `docker.sock` and `podman` under `$XDG_RUNTIME_DIR`
- the `unix://` socket named by `$DOCKER_HOST` or `$CONTAINER_HOST`

On macOS the Seatbelt profile denies connecting to them; on Linux Bubblewrap hides the ones that exist behind an empty mount. This applies to unix sockets only: an engine that listens on a loopback TCP port is reachable when sandbox networking is on.

On macOS the profile also denies writes inside the listed directories, even with `writeOnlyToWorkingDir: false`, so sandboxed tools cannot write `~/.docker/config.json` or Podman and buildah storage under `~/.local/share/containers`. It also denies renaming, chmod-ing or changing the timestamps of each parent directory of a listed path (such as `$HOME` or `$TMPDIR`), which stops a socket from being moved out from under the deny. Creating and deleting files inside those parent directories still works.

Set to `true` only if a sandboxed tool genuinely needs to talk to the container engine directly. A repo config can turn this off but never on. The `docker` and `podman` commands themselves are in `excludedCommands` and are not affected.

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

These examples inherit the default read allowlist and denied paths. If you configure `allowedReadPaths`, include every entry you want to retain: the array replaces the defaults. Configured `deniedPaths` extend the built-in denies, which remain enforced.

### Development (Recommended)

Sandbox enabled, network filtering off. Good for everyday development where you want filesystem protection without network restrictions.

```json
{
  "sandbox": {
    "enabled": true,
    "mode": "auto-allow",
    "filesystem": {
      "writeOnlyToWorkingDir": true
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
      "writeOnlyToWorkingDir": true
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
      "writeOnlyToWorkingDir": true
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
