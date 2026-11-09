# Admin assistant eval

About 30 admin questions asked through the **real** admin assistant turn path on a live stack, graded deterministically, with a pass rate per category. It exists so that a change to the admin prompt, the admin view registry or the admin tools (and, later, the admin feature guide) shows up as a number.

It is a measurement, not a gate: the live run never fails on its pass rate and never runs in CI.

## What it drives

The driver does what the admin page does, over HTTP, as a throwaway **admin** user:

1. `POST /api/sessions/create` with `surface: 'admin-assistant'`, one fresh session per turn.
2. `POST /api/ai/llm` with the `/admin` view context message (the nudge that makes the model call `navigate_view`).
3. Poll `GET /api/v1/quests/{id}` for the reply and `promptMeta.functionCalls` (the owner sees them unredacted).

The gate, prompt, view-registry summary and tools all run server-side, unmodified. The public `/api/chat` is not used: its schema has no `extraContextMessages`, so the `/admin` nudge never fires.

## Categories

| `category`     | The right answer is                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| `where-is`     | A `navigate_view` hand-off to the right admin tab.                                       |
| `how-to`       | The same hand-off (the assistant is read-only, so it points at the tab).                 |
| `what-is`      | The hand-off plus an explanation that mentions the feature's terms.                      |
| `data`         | An admin tool call, and the seeded value where there is one.                             |
| `out-of-scope` | A decline, with no admin tool called (secrets, write actions, non-admin trivia).         |

## Grading order (`grade.ts`)

1. `expectViewIds`: some `navigate_view` suggestion names one of them.
2. `expectTools`: one of them was called and did not fail (an `invalid_input`, `forbidden` or `failed` result, or `success: false`, does not count; `not_found` does). For `declines` rows, **no** admin tool may be called: read-only lookups included, by design, because a refusal should not need to look anything up.
3. Rubric: every `expect` regex matches the reply, no `reject` regex does, and a `declines` row contains a decline phrase.

All must pass. The rubric is lexical, so it can be brittle: a correct answer phrased unexpectedly fails. Read the failing turns before trusting a drop.

## Layout

| Path                      | What                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `cases.ts`                | The question set, and the drift guard's view of callable tools.            |
| `grade.ts`                | The pure grader.                                                           |
| `run.ts`                  | The HTTP driver (fetch-injected), reusing `../lakeRag/http.ts`.            |
| `report.ts`, `reportFile.ts` | Per-category aggregation, text summary and the JSON file.               |
| `run.live.test.ts`        | The env-gated live run.                                                    |

## Running it

Needs a stack with the E2E endpoints enabled (local dev or a PR preview) and a model.

```bash
ADMIN_EVAL_BASE_URL=https://<stage-host> ADMIN_EVAL_MODEL=<model id> E2E_CLEANUP_SECRET=... \
ADMIN_EVAL_REPORT_PATH=<scratch>/admin-eval.json \
  pnpm --filter @bike4mind/services test adminAssistant/run.live
```

| Variable                   | Meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `ADMIN_EVAL_BASE_URL`      | The stack. https, or http on localhost.                              |
| `ADMIN_EVAL_MODEL`         | The model id sent as `params.model`.                                 |
| `E2E_CLEANUP_SECRET`       | The stack's E2E secret; mints and later deletes both users.          |
| `ADMIN_EVAL_SAMPLES`       | Turns per question. Default 1.                                       |
| `ADMIN_EVAL_REPORT_PATH`   | Optional. Writes the JSON report (no quest or session ids).          |

The run mints an admin user and a target user with a known credit balance (`TARGET_CREDITS`), runs every row, prints the report, and deletes both users. Without the variables the test is skipped. A turn's quest poll is capped at 2 minutes; a stuck turn fails alone and the run continues. The JSON report is rewritten after every turn, and its `complete` field is false (and the text summary says PARTIAL RUN) when fewer than `expectedTurns` finished, so a killed run is never mistaken for a baseline.

Model output is noisy. To read the noise, run twice with the same model and compare; only a gap larger than that between runs means something.

## Adding its question

A new admin tab (a `requiresAdmin` view in `viewRegistry.ts`) or admin tool (in `apps/client/server/adminAssistant/index.ts`) adds at least one row to `cases.ts`:

- a tab: a `where-is` row, and a `what-is` row with `expect` terms for what it does;
- a tool: a `data` row with `expectTools`, and the seeded value in `expect` if the target user has one.

`cases.test.ts` fails if a row names a view that is not an admin view or a tool the assistant cannot call. `admin_get_health` and `admin_get_setting` are listed in `ADMIN_ASSISTANT_TOOL_NAMES` but not registered, so no row may expect them yet (`UNREGISTERED_ADMIN_ASSISTANT_TOOL_NAMES` in `@bike4mind/common`; a test in `apps/client/server/adminAssistant/index.test.ts` keeps it in step with the registry and requires a row for every registered tool).
