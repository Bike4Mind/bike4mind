# @bike4mind/cli

## 0.19.0

### Minor Changes

- Version, document, and strictly validate the headless stream-JSON protocol.

  Every headless event (and the `json` result/error object) now carries a
  `schemaVersion` + stable `runId`; the full contract is documented in
  `packages/cli/docs/headless-protocol.md`. Permission decisions surface in-band
  as `permission_request` / `permission_decision` events, and a new
  `--permission-policy` flag drives unattended runs without blanket
  auto-approval.

  Note: `B4M_ADDITIONAL_DIRS` is now validated strictly - a malformed value (not a
  JSON array of strings) fails the run with a clear error instead of being
  silently ignored.

- guided first-run backend onboarding (picker + dev-mode default)

- parse-based shell command risk classification (not tool-name/regex only)

- expose the agent over ACP via a 'b4m acp' subcommand

- backgroundable + pollable shell sessions for bash_execute

- background shell session UX -- live indicators + reaping

- recursion-depth cap and permission clamp for subagents

- record operational-model and KB embedding usage

### Patch Changes

- model API endpoint as discriminated union, fail loud when unconfigured

- stop WS auth rejections from becoming zombie connections + graceful revoke

- make the Zustand store the single source of truth for the session

- unify on a rich message model + a ConversationContext deep module

- shared streaming-completion core for both LLM transports

- redact secrets + enforce output ceiling on all tool return paths

- freeze deferred-tool directory snapshot to keep system-prompt cache stable

- replace exceljs with write-excel-file in excel_generation

- extract slash-command dispatch into a registry

- extract the turn lifecycle into session/turnController
