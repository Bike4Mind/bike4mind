# `b4m acp` - Agent Client Protocol server

`b4m acp` exposes the Bike4Mind agent over the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) - "LSP for coding agents": JSON-RPC 2.0 over stdio. Any ACP-capable editor
(Zed today, more coming) can drive the CLI agent as a subprocess, so B4M shows up
in the editor's agent panel with no per-editor extension work.

It is a third front-end transport in front of the **same** agent core as the
interactive TUI (`b4m`) and headless mode (`b4m -p`). Auth, credits, and model
routing stay server-side; the editor just hosts the thread.

## Running

```bash
b4m acp
```

The process speaks JSON-RPC over stdin/stdout and does not return until the
client disconnects. **stdout carries the protocol frames and nothing else** -
all logging is redirected to stderr. You must be logged in first (`b4m /login`);
an unauthenticated start fails the first `session/new` with an `auth_required`
error.

### Zed

Add to your Zed `settings.json`:

```jsonc
{
  "agent_servers": {
    "Bike4Mind": {
      "command": "b4m",
      "args": ["acp"]
    }
  }
}
```

Then pick "Bike4Mind" in Zed's agent panel.

## Supported methods

| Method | Behavior |
|--------|----------|
| `initialize` | Negotiates protocol version, advertises `loadSession` + `embeddedContext` prompt capabilities. Image prompts are not advertised in v1 (the prompt path is text-only). |
| `session/new` | Validates + confines `cwd` (must be an absolute, existing directory), creates a session. |
| `session/load` | Rehydrates a persisted session and replays its history as `session/update` chunks. |
| `session/prompt` | Runs a ReAct turn, streaming output as `session/update` notifications; returns a `stopReason`. |
| `session/set_mode` | Switches interaction mode. Only **safe** modes are selectable (see below). |
| `session/cancel` | Aborts the running turn for the session (maps to the agent's `AbortSignal`). |

During a prompt turn the agent streams:

- `agent_message_chunk` - assistant text (token-streamed; falls back to the full
  final answer if streaming produced nothing).
- `agent_thought_chunk` - reasoning preamble.
- `tool_call` / `tool_call_update` - a tool entering `in_progress` and reaching
  `completed`, classified into an ACP `ToolKind` for editor iconography.

## Permissions (fail closed)

Gated tools bridge to `session/request_permission`. The editor is offered three
options - **Allow once** (`allow_once`), **Always allow** (`allow_always`), and
**Reject** (`reject_once`) - which map back to the CLI's permission actions.

Permission requests **fail closed to deny**: a client timeout (5 min), a
disconnect, a `session/cancel`, or any unrecognized outcome all resolve to a
denial. An editor client can never widen its own access by stalling.

## Session modes

Only two modes are advertised and accepted over the wire:

- `ask` -> every gated tool triggers a permission prompt (default).
- `plan` -> planning-oriented; still prompts on gated tools.

The CLI's local `auto-accept` (no-prompt) mode is **deliberately not exposed** -
an editor client must not be able to select a mode that bypasses the permission
round-trip. `session/set_mode` rejects any other mode id with `invalid_params`.

## Turn serialization

Sessions share one agent instance and one process working directory, so prompt
turns are serialized through a single mutex. This is stricter than the spec's
per-session requirement and guarantees histories can never interleave. Each turn
`chdir`s to its session's validated `cwd` before running, which is the file-tool
root for that turn.

## Not in v1

- Remote (HTTP/WebSocket) ACP transport - stdio only.
- Editor-delegated auth - auth stays server-side.
- Image prompts - the prompt path is text-only, so `image` is advertised as
  `false`; passing image blocks through as message content is a follow-up.
- `fs/read_text_file` / `fs/write_text_file` delegation to the client (unsaved
  editor buffers) - the agent uses its own file tools against `cwd`.
- Concurrent multi-`cwd` sessions from one process (turns are globally
  serialized and share `process.cwd()`).
