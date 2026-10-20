---
title: Sandbox Commands
description: Complete reference for all /sandbox slash commands
sidebar_position: 2
tags: [reference, commands, sandbox]
---

# Sandbox Commands

Complete reference for all sandbox slash commands. These commands control the OS-level sandbox for bash command isolation.

## Quick Reference

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/sandbox` | — | Show sandbox status |
| `/sandbox:enable` | — | Enable sandbox (auto-allow mode) |
| `/sandbox:disable` | — | Disable sandbox |
| `/sandbox:mode` | `<auto-allow\|permissions>` | Set sandbox mode |
| `/sandbox:trust-domain` | `<domain> [...]` | Trust network domain(s) |
| `/sandbox:domains` | — | Show allowed domains |
| `/sandbox:violations` | `[count]` | Show recent violations |
| `/sandbox:violations:clear` | — | Clear violation log |

---

## `/sandbox`

Show current sandbox status, configuration, and session statistics.

**Usage:**
```bash
/sandbox
```

**Example output:**
```
Sandbox Status:
  Mode: auto-allow
  Platform: darwin (macOS)
  Runtime: seatbelt (sandbox-exec)
  Network Proxy: running (port 54321)

Configuration:
  Filesystem: writes restricted to CWD
  Denied paths: 6 configured
  Allowed read paths: 3 configured
  Excluded commands: docker, watchman, podman

Session Stats:
  Sandboxed: 42
  Unsandboxed: 3
  Blocked: 0
  Violations: 1
```

**What it shows:**
- Current mode (`disabled`, `auto-allow`, or `permissions`)
- Platform and runtime details
- Network proxy status and port
- Configuration summary
- Session statistics since sandbox was enabled

**When to use:**
- After enabling the sandbox to verify it's active
- To check how many commands have been sandboxed
- To review configuration at a glance

---

## `/sandbox:enable`

Enable the sandbox in auto-allow mode. Starts the network proxy if `network.enabled` is `true` in your config.

**Usage:**
```bash
/sandbox:enable
```

**Example output:**
```
Sandbox enabled (auto-allow mode)
Runtime: seatbelt (macOS)
Network proxy: started on port 54321

All bash commands will now be sandboxed.
Tip: /sandbox to check status, /sandbox:disable to turn off
```

**What happens:**
1. Sets sandbox mode to `auto-allow`
2. Detects platform runtime (Seatbelt on macOS, Bubblewrap on Linux)
3. Starts network proxy if network filtering is configured
4. Persists the setting to your config file
5. All subsequent bash commands are wrapped in the OS-level sandbox

**When to use:**
- Starting a development session where you want isolation
- Before running untrusted commands or scripts
- When working in a shared environment

---

## `/sandbox:disable`

Disable the sandbox and stop the network proxy.

**Usage:**
```bash
/sandbox:disable
```

**Example output:**
```
Sandbox disabled
Network proxy: stopped

Bash commands will now execute without sandboxing.
```

**What happens:**
1. Sets sandbox mode to `disabled`
2. Stops the network proxy if running
3. Persists the setting to your config file
4. Subsequent bash commands run without sandbox wrapping

**When to use:**
- When sandbox restrictions interfere with your workflow
- After finishing a security-sensitive task
- When you need full filesystem or network access

---

## `/sandbox:mode`

Switch between sandbox modes without disabling/re-enabling.

**Usage:**
```bash
/sandbox:mode <auto-allow|permissions>
```

**Arguments:**
- `auto-allow` — Sandboxed commands run without permission prompts
- `permissions` — Prompt before each sandboxed command

**Example:**
```bash
/sandbox:mode permissions
```

**Example output:**
```
Sandbox mode set to: permissions
Sandboxed commands will now require approval before execution.
```

**What happens:**
- Changes the sandbox mode without restarting the proxy
- Persists the setting to your config file
- Takes effect immediately for the next command

**When to use:**
- Switching from auto-allow to permissions for a sensitive operation
- Switching back to auto-allow for faster iteration

---

## `/sandbox:trust-domain`

Add one or more domains to the network proxy allowlist. Supports wildcards.

**Usage:**
```bash
/sandbox:trust-domain <domain> [domain2] [domain3] ...
```

**Arguments:**
- `domain` — Domain name to allow. Supports wildcard prefix: `*.example.com`

**Examples:**
```bash
# Trust a single domain
/sandbox:trust-domain api.openai.com

# Trust multiple domains
/sandbox:trust-domain api.openai.com cdn.openai.com

# Trust all subdomains with wildcard
/sandbox:trust-domain *.openai.com
```

**Example output:**
```
Added to allowed domains:
  + api.openai.com
  + cdn.openai.com

Total allowed domains: 20
```

**What happens:**
- Adds domain(s) to the `network.allowedDomains` list
- Updates the running proxy immediately
- Persists to your config file

**Wildcard behavior:**
- `*.github.com` matches `api.github.com`, `raw.github.com`, etc.
- `*.github.com` does **not** match `github.com` (bare domain)
- Domain matching is case-insensitive and port-stripped

**When to use:**
- After a network violation blocks a domain you need
- Setting up allowlist for a new project's dependencies
- Temporarily allowing a domain for a specific task

---

## `/sandbox:domains`

List all domains in the network proxy allowlist.

**Usage:**
```bash
/sandbox:domains
```

**Example output:**
```
Allowed Domains (18):
  registry.npmjs.org
  *.npmjs.org
  pypi.org
  *.pypi.org
  files.pythonhosted.org
  crates.io
  *.crates.io
  rubygems.org
  github.com
  *.github.com
  gitlab.com
  *.gitlab.com
  bitbucket.org
  *.bitbucket.org
  *.githubusercontent.com
  *.cloudflare.com
  api.openai.com
  cdn.openai.com
```

**When to use:**
- Reviewing which domains are allowed before enabling network filtering
- Verifying a domain was added after `/sandbox:trust-domain`
- Auditing network access for security review

---

## `/sandbox:violations`

Show recent sandbox violations (filesystem and network).

**Usage:**
```bash
/sandbox:violations [count]
```

**Arguments:**
- `count` — Number of violations to show (default: 20)

**Example:**
```bash
/sandbox:violations 5
```

**Example output:**
```
Recent Violations (5):

  [filesystem] deny file-write-data /Users/me/.ssh/config
    Command: echo "test" >> ~/.ssh/config
    Blocked by: sandbox
    Time: 2 minutes ago

  [network] Blocked CONNECT to api.stripe.com:443
    Command: [network] CONNECT api.stripe.com
    Blocked by: proxy
    Time: 5 minutes ago

  [filesystem] deny file-read-data /Users/me/.aws/credentials
    Command: cat ~/.aws/credentials
    Blocked by: sandbox
    Time: 8 minutes ago
```

**Color coding:**
- **Yellow** — filesystem violations
- **Cyan** — network violations

**Violation fields:**
- **Type**: `filesystem` or `network`
- **Detail**: What was blocked (file path or domain)
- **Command**: The command that triggered the violation
- **Blocked by**: `sandbox` (OS runtime), `proxy` (network proxy), or `config` (excluded command)
- **Time**: When the violation occurred

**When to use:**
- After a command fails unexpectedly — check if the sandbox blocked it
- Reviewing what access was attempted during a session
- Deciding which paths or domains to add to your allowlist

---

## `/sandbox:violations:clear`

Clear the violation log and reset session statistics.

**Usage:**
```bash
/sandbox:violations:clear
```

**Example output:**
```
Violation log cleared.
Session stats reset.
```

**What happens:**
- Clears all recorded violations from `~/.bike4mind/violations.jsonl`
- Resets session counters (sandboxed, unsandboxed, blocked, violations)

**When to use:**
- Starting a fresh monitoring session
- After resolving all violations by updating config
- Cleaning up a large violation log

---

## Tips

- Run `/sandbox` after enabling to verify everything is active
- Use `/sandbox:violations` after a command fails to understand what was blocked
- Use `/sandbox:trust-domain` when the network proxy blocks a needed domain — it takes effect immediately
- Wildcard domains (`*.example.com`) are useful for services with many subdomains
- Session stats in `/sandbox` give you a quick overview of sandbox activity

## See Also

- [Sandbox Overview](./index.md) — What the sandbox does and how it works
- [Configuration](./configuration.md) — Full config schema and examples
- [Troubleshooting](./troubleshooting.md) — Common issues and solutions
