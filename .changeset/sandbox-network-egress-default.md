---
"@bike4mind/cli": minor
---

Harden the CLI sandbox network gate. Network egress is now fail-closed by default: with the sandbox enabled, all IP egress is denied unless it is explicitly turned on, and the runtime treats network as enabled only when a filtering proxy is actually running (no command sequence can leave the flag on with no proxy). Adds a `/sandbox:network <on|off>` command to toggle egress at runtime. When enabled, HTTP(S)_PROXY-aware clients are filtered against the allowed-domain list; raw sockets bypass the proxy, so leave egress off to deny all outbound connections.
