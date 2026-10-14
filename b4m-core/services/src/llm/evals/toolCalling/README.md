# Tool-calling scorecard

An offline baseline for how well the server agent calls tools. Unlike its siblings ([`../abstention`](../abstention), [`../groundedNoInvention`](../groundedNoInvention), [`../lakeRag`](../lakeRag)), it runs no model: it reads turns that are already stored and aggregates what each one recorded.

Every turn stores two lists on `promptMeta`:

- `offeredTools`: the tools the model was handed.
- `functionCalls`: what it called and how each call went.

The per-turn join is `buildToolUsage` (`../../../telemetry/contextBreakdown.ts`), the same join the per-turn context panel uses. That means both count a call the same way.

## What it reports

These numbers are reported overall and split by `promptMeta.toolMode`. `unset` is any turn whose request named no mode, which includes all in-app chat.

| Metric                    | Meaning                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success` (per tool)      | Successes over calls with a recorded outcome.                                                                                                                                                           |
| `errorClasses` (per tool) | `categorizeToolError` over the recorded observation, plus two extra classes. `malformed_arguments` is the adapters' rejection of the model's arguments. `unrecorded` is a call with no outcome written. |
| `repeatedCalls`           | Same tool, same arguments (key order ignored), earlier in the same turn.                                                                                                                                |
| `callsNotOffered`         | A call to a tool the turn did not offer.                                                                                                                                                                |
| `offeredUncalled`         | Share of the turns offering a tool that never called it.                                                                                                                                                |
| `latencyMs`               | Per-call `executionTime`: mean, p50, p95, max.                                                                                                                                                          |
| `callsPerTurn`            | Over turns that offered at least one tool.                                                                                                                                                              |
| `wasted`                  | Calls that were a repeat or did not succeed, over all calls.                                                                                                                                            |

## Running it

```bash
MONGODB_URI=... pnpm --filter @bike4mind/scripts eval:tool-calling --days 7 --limit 5000 --json report.json
```

The runner is `packages/scripts/toolCallingScorecard.ts`. It only reads quests, but `connectDB` seeds the model catalog as every script does, so run it from a checkout that matches the target deployment. It scores turns that offered or called at least one tool, and it splits by `toolMode` only from turns stored after that field was added.

## Layout

| Path                | What                                                           |
| ------------------- | -------------------------------------------------------------- |
| `scorecard.ts`      | Error classification and aggregation. Pure.                    |
| `format.ts`         | The stdout text summary.                                       |
| `scorecard.test.ts` | Runs in CI.                                                    |
| `index.ts`          | Entry for the `@bike4mind/services/evals/toolCalling` subpath. |
