# Headless stream-JSON protocol

`b4m -p "<prompt>" --output-format stream-json` runs the agent once,
non-interactively, and emits a machine-readable event stream on stdout. This
document is the stable contract for that stream so CI and other tooling can
drive the CLI reliably.

The implementation lives in
[`src/commands/headlessProtocol.ts`](../src/commands/headlessProtocol.ts) and
[`src/commands/headlessCommand.ts`](../src/commands/headlessCommand.ts). This
doc and that module must stay in sync: every event type and field described
here is produced there.

## Output formats

`--output-format` selects one of three shapes:

- `text` (default) - the final answer as plain text on stdout.
- `json` - a single JSON object with the final answer, step trace, and token
  usage. Carries `schemaVersion` and `runId`.
- `stream-json` - newline-delimited JSON (NDJSON): one event object per line,
  emitted as the run progresses, terminated by a `result` (success) or `error`
  event. Every line carries `schemaVersion` and `runId`.

## Envelope

Every `stream-json` event and the `json` result/error object carries an
envelope:

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | string (semver) | Protocol version. See "Versioning" below. |
| `runId` | string (uuid) | Stable id for the whole run; identical on every line of one run. |

## Versioning

`schemaVersion` follows semver:

- **MAJOR** bumps on a breaking change: a field or event type is removed or
  renamed, or an existing field changes meaning. Consumers should reject a
  MAJOR they do not understand.
- **MINOR** bumps on a backward-compatible addition: a new optional field or a
  new event type. Consumers should ignore unknown event types and fields.

Current version: **`1.0.0`**.

## Events (`stream-json`)

Each line is one JSON object. `type` discriminates the event; all events also
carry the envelope fields above.

| `type` | Fields | Meaning |
|--------|--------|---------|
| `thought` | `content` | The agent's reasoning text for a step. |
| `action` | `content`, `toolName`, `toolInput` | The agent invoked a tool. |
| `observation` | `content`, `toolName` | The result returned by a tool. |
| `permission_request` | `toolName`, `risk` | A gated tool is about to run; permission is being decided. `risk` is `{ level: "low"\|"medium"\|"high", reasons: string[] }`. |
| `permission_decision` | `toolName`, `action`, `reason`, `risk` | The decision for a gated tool. `action` is `"allow-once"` or `"deny"`; `reason` explains why; `risk` is the classified level. |
| `result` | `content`, `tokenUsage`, `iterations`, `toolCalls` | Terminal success event with the final answer. `tokenUsage` is `{ totalTokens, inputTokens, outputTokens }`. |
| `error` | `error` | Terminal failure event with the error message. |

A run emits exactly one terminal event (`result` or `error`) as its last line.

## `json` result object

The `json` format emits a single object (not a stream):

```jsonc
{
  "schemaVersion": "1.0.0",
  "runId": "<uuid>",
  "result": "<final answer>",
  "steps": [{ "type": "...", "content": "...", "toolName": "...", "toolInput": {} }],
  "tokenUsage": { "totalTokens": 0, "inputTokens": 0, "outputTokens": 0 },
  "iterations": 0,
  "toolCalls": 0
}
```

On failure it emits `{ "schemaVersion", "runId", "error": "<message>" }` instead.

## Inputs

Structured inputs are validated strictly: an unknown field or a malformed value
fails the run loudly with a clear error rather than being silently ignored.

- `B4M_ADDITIONAL_DIRS` (env) - a JSON array of directory strings. A non-array
  or non-string element is rejected.
- `--permission-policy <path>` - a JSON permission policy (see below).

## Permission policy

By default a gated tool is denied in headless mode (no silent auto-approve).
Two mechanisms grant access:

- `--dangerously-skip-permissions` - blanket allow of every gated tool. Use
  only in fully-trusted CI.
- `--permission-policy <path>` - a declarative, per-tool policy for unattended
  runs. Its JSON shape (unknown fields rejected):

  | Field | Type | Default | Meaning |
  |-------|------|---------|---------|
  | `allow` | string[] | `[]` | Exact tool names always allowed. |
  | `deny` | string[] | `[]` | Exact tool names always denied. Wins over `allow`. |
  | `maxAutoAllowRisk` | `"low"`\|`"medium"`\|`"high"` | (unset) | Auto-allow any tool whose classified risk is at or below this level. Unset disables risk-based allow. |
  | `defaultAction` | `"allow"`\|`"deny"` | `"deny"` | Verdict when no rule matches. |

  Precedence per tool: `deny` list > `allow` list > `maxAutoAllowRisk`
  threshold > `defaultAction`.

  Example - allow reads and low-risk commands, deny shell, otherwise deny:

  ```json
  {
    "allow": ["read_file", "find_definition"],
    "deny": ["bash_execute"],
    "maxAutoAllowRisk": "low",
    "defaultAction": "deny"
  }
  ```

Decision precedence overall: `--dangerously-skip-permissions` >
`--permission-policy` > default deny. Every decision is surfaced as a
`permission_decision` event in `stream-json` mode, so no approval is silent.

## Exit codes

- `0` - the run completed and emitted a `result`.
- `1` - the run failed and emitted an `error` (or a startup error before the
  stream began).

## Example

```console
$ b4m -p "list the files here" --output-format stream-json --permission-policy ci-policy.json
{"schemaVersion":"1.0.0","runId":"...","type":"thought","content":"I should list the directory."}
{"schemaVersion":"1.0.0","runId":"...","type":"permission_request","toolName":"bash_execute","risk":{"level":"low","reasons":[]}}
{"schemaVersion":"1.0.0","runId":"...","type":"permission_decision","toolName":"bash_execute","action":"allow-once","reason":"risk low <= maxAutoAllowRisk low","risk":"low"}
{"schemaVersion":"1.0.0","runId":"...","type":"action","content":"","toolName":"bash_execute","toolInput":{"command":"ls"}}
{"schemaVersion":"1.0.0","runId":"...","type":"observation","content":"...","toolName":"bash_execute"}
{"schemaVersion":"1.0.0","runId":"...","type":"result","content":"...","tokenUsage":{"totalTokens":0,"inputTokens":0,"outputTokens":0},"iterations":1,"toolCalls":1}
```
