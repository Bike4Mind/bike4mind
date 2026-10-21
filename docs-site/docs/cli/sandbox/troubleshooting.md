---
title: Sandbox Troubleshooting
description: Common sandbox issues and solutions
sidebar_position: 4
tags: [troubleshooting, sandbox]
---

# Sandbox Troubleshooting

Common issues you may encounter when using the CLI sandbox, with symptoms, causes, and solutions.

## "Sandbox runtime not available"

**Symptoms:** Warning message when enabling sandbox. Commands run unsandboxed despite sandbox being enabled.

**Cause:** The sandbox runtime binary is not installed or not found in PATH.

**Solution:**

- **macOS:** `sandbox-exec` is built into macOS. If missing, verify your macOS version supports it (macOS 10.5+). Check with:
  ```bash
  which sandbox-exec
  ```

- **Linux:** Install Bubblewrap via your package manager:
  ```bash
  # Debian/Ubuntu
  sudo apt install bubblewrap

  # Fedora/RHEL
  sudo dnf install bubblewrap

  # Arch Linux
  sudo pacman -S bubblewrap
  ```
  Verify with:
  ```bash
  which bwrap
  ```

## Command fails with permission denied

**Symptoms:** A bash command fails or produces empty output. Error messages mention "deny" or "Permission denied".

**Cause:** The sandbox is blocking filesystem access that the command needs.

**Solution:**

1. Check what was blocked:
   ```bash
   /sandbox:violations
   ```

2. If a read path was blocked, add it to `allowedReadPaths` in your config:
   ```json
   {
     "sandbox": {
       "filesystem": {
         "allowedReadPaths": [
           "$HOME/.gitconfig",
           "$HOME/.npmrc",
           "$HOME/.your-needed-path"
         ]
       }
     }
   }
   ```

3. If a write path was blocked, remember that writes are restricted to your CWD. Either:
   - Change your working directory to where the file needs to be written
   - Temporarily disable the sandbox for that operation: `/sandbox:disable`

## Network request blocked

**Symptoms:** Commands that need network access fail. `curl`, `wget`, `npm install`, or API calls time out or return connection errors.

**Cause:** The domain is not in the network proxy allowlist.

**Solution:**

1. Check violations to see which domain was blocked:
   ```bash
   /sandbox:violations
   ```

2. Add the domain to the allowlist:
   ```bash
   /sandbox:trust-domain api.example.com
   ```

3. For services with many subdomains, use a wildcard:
   ```bash
   /sandbox:trust-domain *.example.com
   ```

4. Or add permanently to your config file under `sandbox.network.allowedDomains`.

:::tip
The violation log shows the exact domain that was blocked, including the method (`CONNECT` for HTTPS, `GET`/`POST` for HTTP). Use this to determine the correct domain to trust.
:::

## Proxy won't start

**Symptoms:** `/sandbox:enable` succeeds but reports no proxy. Network filtering not active.

**Cause:** Either `network.enabled` is `false` or a port conflict prevented the proxy from binding.

**Solution:**

1. Verify network filtering is enabled in your config:
   ```json
   {
     "sandbox": {
       "network": {
         "enabled": true
       }
     }
   }
   ```

2. The proxy binds to `127.0.0.1` on an automatically assigned port (port 0). Port conflicts are rare, but if another process is interfering, check with:
   ```bash
   lsof -i -P | grep LISTEN
   ```

3. Re-enable the sandbox:
   ```bash
   /sandbox:disable
   /sandbox:enable
   ```

## Docker/Podman commands fail

**Symptoms:** `docker`, `podman`, or `watchman` commands fail when sandbox is enabled with `allowUnsandboxedCommands: false`.

**Cause:** These commands are in the `excludedCommands` list. When `allowUnsandboxedCommands` is `false`, excluded commands are blocked entirely.

**Solution:**

- Set `allowUnsandboxedCommands: true` in your config to let excluded commands run without sandbox wrapping:
  ```json
  {
    "sandbox": {
      "allowUnsandboxedCommands": true
    }
  }
  ```

- Or add the specific command to `excludedCommands` if it's not already there:
  ```json
  {
    "sandbox": {
      "excludedCommands": ["docker", "watchman", "podman", "your-command"]
    }
  }
  ```

## Violations not showing

**Symptoms:** `/sandbox:violations` shows no results even though commands seem to be restricted.

**Cause:** Several possibilities:
- Sandbox is not actually enabled (mode is `disabled`)
- The command succeeded — no violation was generated
- Violations are stored in a different location

**Solution:**

1. Verify sandbox is enabled:
   ```bash
   /sandbox
   ```

2. Run a command that should trigger a violation to test:
   ```bash
   cat ~/.ssh/id_rsa
   ```

3. Check violations again:
   ```bash
   /sandbox:violations
   ```

4. Violations are stored in `~/.bike4mind/violations.jsonl`. Verify the file exists and has content.

## Performance concerns

**Symptoms:** Commands feel slower with sandbox enabled. Noticeable delay before command output appears.

**Cause:** Sandbox wrapping adds a small overhead per command — the runtime needs to create a profile, launch the sandboxed process, and parse results.

**Solution:**

- Use **`auto-allow`** mode (the default when you `/sandbox:enable`). This avoids the additional delay of permission prompts.
- For performance-critical workflows, temporarily disable the sandbox:
  ```bash
  /sandbox:disable
  # ... run performance-sensitive commands ...
  /sandbox:enable
  ```
- The overhead is typically negligible for individual commands but can add up in tight loops.

## macOS SIP or Linux AppArmor conflicts

**Symptoms:** Sandbox fails to apply restrictions. Commands run but without expected isolation. Error messages about security policies.

**Cause:** System-level security policies (macOS System Integrity Protection, Linux AppArmor/SELinux) may interfere with sandbox-exec or bwrap.

**Solution:**

- **macOS:** SIP generally does not conflict with Seatbelt profiles. If you see unexpected behavior, check Console.app for sandbox-related system logs.

- **Linux AppArmor:** Bubblewrap needs permission to create user namespaces. Check:
  ```bash
  # Verify user namespaces are enabled
  cat /proc/sys/kernel/unprivileged_userns_clone
  # Should output: 1
  ```
  If disabled, enable with:
  ```bash
  sudo sysctl kernel.unprivileged_userns_clone=1
  ```

- **Linux SELinux:** You may need to adjust SELinux policies to allow bwrap operations. Check audit logs:
  ```bash
  sudo ausearch -m AVC -ts recent
  ```

## See Also

- [Sandbox Overview](./index.md) — How the sandbox works
- [Commands Reference](./commands.md) — All sandbox commands
- [Configuration](./configuration.md) — Full config schema and adjustment options
