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
- Agent lifecycle hooks (PreToolUse/PostToolUse/Stop and friends) that previously ran their shell command unprompted are now gated through the same permission prompt as any other shell command, and can be denied. Trusting the project folder loads the hook definitions; it no longer pre-authorizes the commands they carry.
- A `.b4m/checkpoints.json` whose root is not an object (e.g. a committed `[]`) no longer overwrites the metadata container, so checkpoints created after such a file is read are kept across restarts instead of being silently discarded.
