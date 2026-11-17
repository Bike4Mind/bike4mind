# Desktop orchestration prompt baseline

## Evidence boundary

This is an offline, sanitized request-shape baseline, not a provider-cost or
accepted-task benchmark. No paid requests were made. Estimated tokens use the
existing Desktop `estimateTextTokens` function, not a provider tokenizer.
Deferred definitions remain serialized on the Desktop-to-proxy request; their
length is not evidence that a provider charges them as loaded prompt tokens.

Reproduce from `apps/desktop` after building workspace dependencies:

```sh
B4M_PROMPT_BASELINE=1 VITEST_MAX_WORKERS=25% pnpm exec vitest run src/main/chat/promptFootprint.test.ts src/main/chat/deferredTools.test.ts src/main/chat/ChatService.deferredTools.test.ts
```

The fixture uses a synthetic root, instructions and skill listing, actual Desktop
guidance and registry schemas, a zero-token optional start set, no media, and no
connected MCP schemas. It is intentionally smaller than a real user's setup.
Exported JSON contains fixed block categories, SHA-256 hashes, character lengths,
and token estimates, not prompt text, paths, IDs or task contents. Do not substitute
private prompts into an exported fixture: hashes and lengths are fingerprints,
not anonymization guarantees. No production prompt capture or logging is added.

## Measured source sizes

| Block | Characters | Estimated tokens |
| --- | ---: | ---: |
| Stable system excluding fixture instructions and skills | 4,367 | 1,092 |
| Fixture project instructions | 95 | 24 |
| Fixture skills | 49 | 13 |
| Tool/access state | 9,182 | 2,296 |
| Loaded tools | 2,298 | 575 |
| Deferred declarations including anchor | 35,826 | 8,957 |

The test names the growing block on a budget failure. Budgets allow modest schema
changes rather than asserting exact provider credits. Reported hashes are emitted
by the reproduction command so intentional guidance changes can be compared.

## Selected optimization

Previously every live deferred tool-set change appended the entire tool/access
reminder to the latest user/tool-result message, even when that reminder was
byte-identical to the current one. Now an identical reminder is not appended;
the tool addition/removal message is still emitted. Changed guidance (including
folder/access changes) is always appended. Stored state, tool declarations,
permission checks, repository instructions and user instructions are unchanged.

On the matched synthetic tool-result fixture, serialized history falls from
19,046 characters / 4,762 estimated tokens to 9,681 / 2,421. The avoided duplicate
is 9,365 characters / 2,341 estimated tokens. This is one qualifying state change,
not a claimed reduction for an entire job. No savings occur when guidance changes
or there is no live tool-set change. The ordinary non-deferred path is unchanged.

Integration tests exercise both mid-turn MCP additions and removals and recreate
ChatService before the next turn. They verify preserved stable-head hashes,
declared-before-use tools, retained tool-result evidence and current declarations.
Existing tests cover revoked-tool refusal, unsupported providers, deferral toggle
rollback, zero start set, and ordinary replay. A mid-turn state is still relocated
on replay by existing persistence logic; removals may need a superseding record.
This change does not claim to eliminate that known prefix rewrite.

## Unknowns and unproven issue criteria

- Ordinary input, cache reads, cache writes by 5-minute/1-hour TTL, output tokens,
  provider-priced cost, attempt count and accepted-task outcome are **unknown**
  for this offline baseline, represented as null in the report, never zero.
- Equal hashes prove equal source bytes only. Neither cache flags, a requested TTL,
  nor a warm-looking request proves a provider cache hit. Rewrite causes remain
  unknown without provider usage and matched request evidence.
- Controlled fresh/warm jobs, sustained loops, worker creation, parent wakes,
  real process restart, pauses across both TTL boundaries, compaction cost and
  matched total cost per accepted result have not been evaluated here.
- A smaller start set is exercised through existing `declareDeferredTools` and
  integration tests, not rolled out. Direct-Anthropic capability checks are
  unchanged; other backends do not acquire this optimization path.
- No TTL, compaction, model-selection, permission or rollout default changes.
  Existing `B4M_DESKTOP_DEFERRED_TOOLS=0` disables this path, and
  `B4M_DESKTOP_DEFERRED_START_MAX_TOKENS=0` remains the optional-start-set experiment
  control. Existing TTL and compaction controls remain independent.

The measured improvement is duplicate request-shape reduction only. Provider
cost-per-accepted-result and full baseline acceptance remain open pending an
authorized controlled evaluation; this evidence must not be presented as proving
the full issue complete.

## Verification limitations

The initial focused run passed both footprint tests and all 17 deferred-tool
helper tests. The service suite passed 17/18, exposing an overstrict new assertion
that removals would not add a superseding state record; that assertion was corrected
to preserve the existing replay contract. The subsequent chat/shared run exceeded
240 seconds with failures and no final failure summary. Final focused reruns also
timed out before a complete result; final integration assertions are not claimed
as passing. Testing stopped at the five-minute budget. Desktop fast typecheck,
changed-file ESLint and whitespace checks passed on the final code. No live app or
provider end-to-end evaluation was performed.
