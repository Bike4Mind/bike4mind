---
'@bike4mind/cli': minor
'@bike4mind/utils': minor
---

harden the CLI trust boundary against a hostile cloned repo

Behavior changes (all user-visible effects of hardening the CLI against an untrusted clone):

- The shared utils barrel no longer runs `dotenv.config()` on import, so a project-local `.env` is no longer auto-loaded. Configuration now resolves from the real process environment. Set the variables in your shell (or your process manager) instead of relying on a cwd `.env`.
- Non-YAML frontmatter in a skill, command, or agent file (e.g. a `---js` fence) no longer evaluates; such frontmatter is treated as empty instead of running code at load time.
- A `--session-id`/`--resume` value outside the strict session-id charset is now rejected up front rather than used as a filesystem path component.
- A project skill/command/agent whose file is a symlink escaping the project root is refused when loading from an untrusted checkout.
- A `global` or `remote` skill whose name is reserved (a built-in or live feature/plugin command) is no longer advertised to the model or invokable, matching the dispatch gate.
