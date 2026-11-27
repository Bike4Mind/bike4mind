---
title: CLI Sandbox
description: OS-level command isolation for secure bash execution
sidebar_position: 1
tags: [security, sandbox, isolation]
feature_status: beta
---

# CLI Sandbox

The CLI Sandbox provides **OS-level isolation** for bash commands using macOS Seatbelt (`sandbox-exec`) or Linux Bubblewrap (`bwrap`). It prevents commands from reading sensitive files, writing outside your working directory, or contacting unauthorized network domains.

:::info Beta Feature
The sandbox is currently in beta. It works well for most development workflows, but some edge cases may require adjustments to your configuration.
:::

## Platform Support

| Platform | Runtime | Binary | Status |
|----------|---------|--------|--------|
| macOS | Seatbelt | `sandbox-exec` (built-in) | Supported |
| Linux | Bubblewrap | `bwrap` (install via package manager); `socat` for network filtering | Supported |
| Windows | Not supported | — | — |

## Quick Start

```bash
/sandbox:enable          # Enable sandbox (auto-allow mode)
/sandbox                 # Check status
/sandbox:disable         # Disable when done
```

That's it. Once enabled, all bash commands are wrapped in an OS-level sandbox that restricts filesystem and (optionally) network access.

## What Gets Isolated

### Filesystem

- **Writes** are restricted to your current working directory and `/tmp`
- **Sensitive paths** are blocked for both read and write, including SSH keys, cloud credentials, CLI configuration, and package registry credentials. See the [default denied paths](./configuration.md#deniedpaths).
- **Common config reads** are allowed: `~/.gitconfig` and `~/.node_modules`
- **Project configuration** in `.bike4mind` and Git metadata in `.git` are read-only, including when writes outside the working directory are enabled. Git operations that update metadata require a trusted operation outside the sandbox.
- Configure read access and general write restrictions in the [filesystem configuration](./configuration.md#filesystem-configuration).

### Network (Opt-in)

When `network.enabled` is set to `true`, an HTTP proxy filters all outbound connections:

- **Default allowlist** includes package registries and code hosting: npm, PyPI, crates.io, RubyGems, GitHub, GitLab, Bitbucket, Cloudflare
- **Unknown domains** are blocked and logged as violations
- **Add domains on the fly** with `/sandbox:trust-domain <domain>`

Network filtering is disabled by default. Enable it in your [configuration](./configuration.md#network-configuration) for stricter isolation.

## Sandbox Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `disabled` | No sandboxing | Default — sandbox is off |
| `auto-allow` | Sandbox without permission prompts | Recommended for development |
| `permissions` | Prompt before each sandboxed command | Maximum control |

**`auto-allow`** is the recommended mode. Since the OS-level sandbox provides the security boundary, bash commands execute without permission prompts — the sandbox itself is the safety net.

**`permissions`** mode still wraps commands in the sandbox but also prompts you before each execution, giving you a chance to review what will run.

## Excluded Commands

Some commands are incompatible with sandbox wrapping and run unsandboxed:

- `docker`
- `watchman`
- `podman`

You can customize this list via the `excludedCommands` config option. Setting `allowUnsandboxedCommands: false` blocks excluded commands entirely instead of running them unsandboxed.

## Limitations

- **Not a container** — the sandbox uses OS-level profiles, not full containerization. It shares the host kernel.
- **No CPU/memory limits** — no cgroup or resource isolation.
- **No process tree isolation** — child processes inherit sandbox restrictions on macOS but are not namespaced.
- **Excluded commands bypass the sandbox** — docker, podman, and watchman run without restrictions unless you set `allowUnsandboxedCommands: false`.
- **No container engine access from sandboxed commands** - container engine sockets (Docker, Podman, Colima, Lima, Rancher Desktop, OrbStack) are unreachable unless you set `allowContainerSockets: true`.
- **Platform-dependent** — Seatbelt and Bubblewrap have different granularity and enforcement mechanisms.

## Next Steps

- [Commands Reference](./commands.md) — All 8 sandbox slash commands
- [Configuration](./configuration.md) — Full config schema and examples
- [Troubleshooting](./troubleshooting.md) — Common issues and solutions
- 