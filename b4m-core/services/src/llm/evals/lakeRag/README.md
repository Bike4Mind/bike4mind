# Lake RAG eval

A question bank and a deterministic grader for data-lake retrieval against a **real** lake. It checks whether the model answers from the current document when the lake also holds a stale or conflicting one, and whether it says so when the lake has no answer.

Siblings [`../abstention`](../abstention) and [`../groundedNoInvention`](../groundedNoInvention) pin a prompt against invented `.ts` fixtures. This eval keeps its corpus as markdown files instead, because a live driver uploads them to a lake and the frontmatter `date:` has to survive the upload: it becomes `FabFile.documentDate` (`b4m-core/fab-pipeline/src/documentDate.ts`) and appears in the passage header (`renderRetrievedContentBlock.ts`).

It also holds the live driver (`run.live.test.ts`), which builds the lakes on a real deployment through the public HTTP API, asks every question under three arms, and writes a JSON report. See [Running the live half](#running-the-live-half).

## Layout

| Path                               | What                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| `corpus/<subject>/*.md`            | Current documents. Each one carries a frontmatter `date:`.            |
| `corpus/<subject>/superseded/*.md` | Older generations of a current document, with the **same file name**. |
| `bank.json`                        | The questions. Validated on load by `bank.ts`.                        |
| `grade.ts`                         | The scorer.                                                           |
| `provision.ts`, `corpus.ts`        | Lake creation, upload, ingestion polling and teardown.                |
| `auth.ts`                          | The live run's credential: an API key or a throwaway e2e user.        |
| `run.ts`                           | The three arms and retrieval detection.                               |
| `report.ts`, `reportFile.ts`       | Aggregation, the noise-band comparison and the JSON file.             |
| `run.live.test.ts`                 | The env-gated live run.                                               |
| `index.ts`                         | Entry for the `@bike4mind/services/evals/lakeRag` subpath.            |

The subjects (`planetary-moons`, `si-units`, `us-census`) have nothing to do with each other on purpose. In the driver's multi-lake arm, each one is a distractor lake for the others. The prose is original. The facts come from public-domain U.S. government sources (NASA, NIST, the Census Bureau), and each document names its source in its frontmatter. The stale documents carry the values those sources published at the earlier date.

The corpus is not part of the built package. A driver in another workspace package reads it from source, at `src/llm/evals/lakeRag/corpus` under the `@bike4mind/services` package root.

## Case kinds

Each kind is scored on its own (`scoreByKind`), because each planted kind tests a different mechanism.

| `kind`                 | What the lake holds                                                              | Mechanism under test                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fact`                 | One document with the answer.                                                    | Plain retrieval. This is the control.                                                                                                                     |
| `stale-same-name`      | An older and a newer generation of one file name, both in the lake.              | Same-identity supersession (`dataLakeService/supersession.ts`). The newest generation by `createdAt` should be the only one ranked.                       |
| `stale-different-name` | A different file with an older `date:` and the same metric at a different value. | The conflict note (`retrievalConflictNote.ts`) and the model's own preference for the newer dated passage. The note only fires for `metric-disagreement`. |
| `absent`               | Nothing that answers the question.                                               | The model says the lake lacks the answer.                                                                                                                 |

### Upload order matters

Supersession picks the winner by `createdAt`, not by the `date:` in the frontmatter. For each subject:

1. Upload every file in `superseded/` **first**.
2. Then upload the files at the subject root.

Upload them as plain files, without a `relativePath` that includes the `superseded/` folder. The two generations must collide on the file-name tier of `sourceIdentityKeyFor`. If they carry different relative paths they are two separate documents, and the `stale-same-name` case is no longer testing supersession.

## Bank rows

```json
{
  "id": "moons-same-name-saturn-count",
  "subject": "planetary-moons",
  "kind": "stale-same-name",
  "question": "How many confirmed moons does Saturn have?",
  "expect": ["146"],
  "expectSource": "giant-planet-moons.md",
  "rejectTokens": ["82"]
}
```

`expect` and `rejectTokens` are regex sources, matched case-insensitively and only as whole tokens: `82` does not match `182` or `8.82`. Put alternatives inside one pattern (`"seven|7"`). Every `expect` pattern must match. An `absent` row has no `expect` and a null `expectSource`, and a stale row must name at least one `rejectToken`. `loadLakeRagBank` throws on any row that breaks these rules.

## Grading

`gradeLakeRag(row, reply, context)` passes only if all three checks pass:

- **Answer.** Every `expect` pattern appears in the reply. For `absent`, the reply has to say the lake lacks the answer. That is all it checks: a reply that names the gap and then answers from general knowledge still passes, because it has not presented the outside answer as the lake's.
- **Stale rejection.** No `rejectTokens` value appears in a sentence that presents it as current. A sentence that marks the value as historical ("up from an earlier count of 82", "replacing the International Prototype", "one fewer than its 53", "in 2010 it was near Plato") is allowed. A bare "was" or "had" is not a marker, since "the center was near Plato" asserts the stale value. A failure quotes the sentence that tripped it. The marker only covers its own sentence. Sentences split on `.` but not on a decimal point, so the stale figure in "308.7 million" is still caught.
- **Citation.** With `{ citationStyle: 'indexed', citables }`, each `[N]` resolves to `citables[N-1]` (`promptMeta.citables`, whose document `title` is the file name). At least one marker has to resolve to `expectSource`. A marker outside `citables` fails the check (`dangling`), because the UI would render it as a chip that points at nothing. Only one- or two-digit markers count, so a bracketed year or count (`[2016]`, `[146]`) is not read as a citation. With `{ citationStyle: 'named' }`, the reply has to name the file, with or without the extension or hyphens.

The grader works on the words of the reply, like its siblings. An unusual paraphrase can slip past it, but a reply that states the stale value as the answer cannot.

## What runs where

| File                                                                 | Runs in CI | What it pins                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | :--------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grade.test.ts`                                                      |    yes     | The grader, against fixture replies for every `kind`.                                                                                                                                                                                                                                         |
| `provision.test.ts`, `auth.test.ts`, `run.test.ts`, `report.test.ts` |    yes     | The driver against a mocked `fetch`: stale-first upload order, moderation and ingestion polling, teardown on failure, the session body per arm, retrieval detection, and the report math.                                                                                                     |
| `run.live.test.ts`                                                   | no, skips  | The whole loop against a live deployment. Skips unless its env is set.                                                                                                                                                                                                                        |
| `bank.test.ts`                                                       |    yes     | The bank against the corpus. Each subject has at least 10 questions and at least 2 of each planted kind. Each expected value is in its current source. Each stale value is in an older-dated document, and that document has the same file name or a different one, as the row's `kind` says. |

## Running the live half

It drives a deployed stage over HTTP, so nothing runs locally but the test process:

```bash
LAKE_RAG_EVAL_BASE_URL=https://<your-stage-host> \
LAKE_RAG_EVAL_MODEL=<model id> \
LAKE_RAG_EVAL_API_KEY=b4m_live_... \
PROMPT_EVAL_REPORT_PATH=/tmp/lakerag-report.json \
  pnpm --filter @bike4mind/services test lakeRag/run.live
```

| Variable                      | Purpose                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAKE_RAG_EVAL_BASE_URL`      | The stage to drive. Required.                                                                                                                                                                            |
| `LAKE_RAG_EVAL_MODEL`         | Model id sent with every chat turn. Required.                                                                                                                                                            |
| `LAKE_RAG_EVAL_API_KEY`       | A `b4m_live_` key with `datalake:write`, `files:write`, `files:read`, `notebooks:write` and `ai:chat`. The stage needs the `EnableDataLakes` admin setting on.                                                                |
| `E2E_CLEANUP_SECRET`          | Used only when no API key is set: mints a throwaway user through `/api/test/create-user` (stages with E2E endpoints enabled) and deletes it afterwards. Its 30-minute JWT is renewed through `/api/auth/refreshToken` before expiry and on a 401; a 401 that survives renewal aborts the run. |
| `LAKE_RAG_EVAL_SAMPLES`       | Turns per question per arm. Default 1. A value that is not a positive integer is a hard error.                                                                                                           |
| `PROMPT_EVAL_REPORT_PATH`     | Where the JSON report is written. Overwritten, not appended, unlike the sibling evals.                                                                                                                   |
| `LAKE_RAG_EVAL_BASELINE_PATH` | An earlier JSON report. The run compares itself against it and fails if a banded metric moved outside the noise band.                                                                                    |

The suite skips unless the base URL, the model and one credential are set. It creates one lake per subject, uploads every superseded generation and waits for it to be ingested before uploading the current one, promotes each lake out of draft once its files are ready (a draft lake does not ground chat), and runs the questions one fresh session at a time. `afterAll` detaches the files and archives the lakes, and fails the suite if any delete failed, so a leftover lake is never silent. On the e2e path the user cleanup deletes the user's lakes, files, sessions and quests outright. On the API-key path the lakes are archived rather than deleted, and the uploaded files, sessions and quests stay on the key owner's account, because the public API has no file DELETE. Every request that gets a 429 is retried after the `Retry-After` header or the body's "retry in Ns" hint, at most 4 times and 180 seconds in total per request; other errors are not retried. The base URL must be https unless it is localhost.

### The arms

| Arm          | Session                                                                          | Scored on                          |
| ------------ | -------------------------------------------------------------------------------- | ---------------------------------- |
| `lake`       | Bound to the subject's lake, indexed citations.                                  | Answer, stale rejection, citation. |
| `multi-lake` | The same, plus the other subjects' lakes as distractors through `retrievalTags`. | Answer, stale rejection, citation. |
| `plain`      | No lake, `promptMode: 'raw'`. The bare-model baseline.                           | Answer and stale rejection only.   |

The plain arm has no lake, so an `absent` row ("the lake lacks this") cannot pass there by construction. Its `absent` rows are reported as n/a and left out of the plain pass rate.

Retrieval counts as having run when the turn's `promptMeta.citables` holds a document or the model called a knowledge-base search tool. The driver reads both from `GET /api/v1/quests/{id}`, because the chat response carries no `promptMeta`. Expect a lake retrieval rate near 100% and a plain one near 0%. Anything else means the detection or the wiring is wrong, not the model.

### The report

The run prints a text summary to stdout: pass and retrieval rate per arm, per-kind pass rates, the multi-lake drop (lake pass rate minus multi-lake pass rate), the baseline verdict when one is set, and every failing turn with its reason. The JSON file holds the same numbers plus every graded turn.

Run it twice with the same model before reading a change as signal. The noise band (`LAKE_RAG_NOISE_BAND`) for two runs at one sample: overall pass rate per arm within 10 points, lake and multi-lake retrieval rate within 5, multi-lake drop within 10. Per-kind rates are reported but not banded, because with 6 rows per planted kind one row is 16.7 points.
