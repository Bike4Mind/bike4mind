---
"@bike4mind/cli": minor
---

Treat Hearth log content as data, never instructions

Every `hearth_*` read now arrives inside an envelope marking it untrusted, and the
system prompt states that log content is data to report rather than instructions
to follow, that a delegation is a request to surface rather than an authorization
to execute, and that only the user directs the agent's actions. Channel names are
covered as well as event bodies: a name is 200 characters of unfiltered text
writable by any `hearth:write` holder, and the agent is told to read channels
first, so it was the earliest attacker-controlled string in a session.

Not named `pr-1090.md` deliberately. The auto-changeset workflow owns `pr-<N>.md`
files and only clears a stale one when the PR type becomes non-publishable, so a
retitle from `feat(hearth)` to `feat(cli)` left a bump for `@bike4mind/hearth`
in place - a package this change does not touch. A manually-named changeset is
outside the workflow's management and is what the repo already does for
cli-sse-only-transport.md.
