# Guarded Desktop live evaluation

This is a blocked implementation path, not paid evaluation evidence. No provider
calls were made during implementation. The existing offline harness remains intact.

The Electron main process recognizes `--controlled-cost-evaluation-live`. Without
that exact argument it does nothing. With it, the current build writes
`controlled-evaluation/blocked.json` under Electron userData, before consulting
auth or making network calls. There is deliberately no environment variable,
JSON proof, CLI flag or local setting that clears either execution blocker:

- The issuer must amend the existing dedicated-key authorization to permit this
  signed-in backend route. The coordinator owns that request.
- The backend must expose a verifiable maximum billed-input/output/retry contract
  for this route. The existing completion contract exposes an output request
  ceiling, not proof that hidden tokens or server/provider retries share it.

Do not remove these blockers just to run the fixture. Implementation is not
authorization, and an application budget is not a global provider-key cap.

## Implemented path

After those gates are implemented and reviewed, the entry point uses
`AuthService.getSessionBoundApiClient()`, the account's real ModelCatalog and real
ChatService. It neither reads auth stores nor accepts provider keys. Only the
exact available OpenAI-backed `gpt-6.1-sol` record is admitted; there is no Opus
fallback. The catalog price map is recorded. Two sequential isolated file-read
fixtures compare reference and zero deferred start set. Acceptance requires a
successful file_read and the exact single-character answer, not just a success
HTTP response. No other tools, workers or model upgrades are admitted.

An AsyncLocalStorage scope gates hosted `streamCompletion` requests, including
auxiliary requests, retries and any continuations in that evaluator scope, without
gating normal user chat. A SQLite WAL/FULL transaction reserves before POST, with
one shared fixed ledger across arms and restarts, at most $150, 20 requests,
131072 input tokens, 2048 output tokens, four rounds per fixture and zero workers.
Input JSON has a stricter byte envelope; that envelope is not a verified provider
tokenizer bound, which is one reason execution remains blocked. Reservations use
the full input ceiling at the highest published rate (including 1h cache writes)
plus the full output ceiling, never a cache-hit assumption. Concurrent admissions
are refused. The transaction also refuses any unresolved previous attempt.

Reservations are never refunded by client usage. Every failed, disconnected or
unreconciled attempt retains its full hold on disk. Request-scoped SSE usage is
folded by replacement, never by adding cumulative turn events. Matching settlement
records platform USD and credits separately; it does not establish provider cost.
Even a usage-reported settled request blocks further admission until provider
billing is reconciled. Reports omit prompts, outputs, paths, session/request IDs,
tool arguments, exception text and credentials; unknown costs remain null.

## Remaining scope

This is intentionally incomplete while authorization and billing bounds are
pending: provider-priced reconciliation (including reasoning/cache semantics and
hidden retry bounds), safe release of reservations, exact tokenizer validation,
and a verified authorized execution gate. The matched fixture path has not run
against a paid backend. Full cache-TTL waits, warm/restart/compaction acceptance,
worker/wake cases and the larger quality/latency matrix are not implemented here.
Worker coverage currently means admission is denied, not measured worker spend.
There is no claim of savings or completion of the live-cost issue.
