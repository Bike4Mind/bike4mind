---
"@bike4mind/cli": minor
"@bike4mind/utils": minor
---

harden the CLI trust boundary against a hostile cloned repo

Behavior change: the shared utils barrel no longer runs `dotenv.config()` on import, so a project-local `.env` is no longer auto-loaded. Configuration now resolves from the real process environment. Set the variables in your shell (or your process manager) instead of relying on a cwd `.env`.
