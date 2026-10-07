# Lake RAG eval

A question bank and a deterministic grader for data-lake retrieval against a **real** lake. It checks whether the model answers from the current document when the lake also holds a stale or conflicting one, and whether it says so when the lake has no answer.

Siblings [`../abstention`](../abstention) and [`../groundedNoInvention`](../groundedNoInvention) pin a prompt against invented `.ts` fixtures. This eval keeps its corpus as markdown files instead, because a live driver uploads them to a lake and the frontmatter `date:` has to survive the upload: it becomes `FabFile.documentDate` (`b4m-core/fab-pipeline/src/documentDate.ts`) and appears in the passage header (`renderRetrievedContentBlock.ts`).

This directory holds data and a pure scorer only. The live driver that creates the lake, uploads the corpus and calls the API is separate work.

## Layout

| Path                               | What                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| `corpus/<subject>/*.md`            | Current documents. Each one carries a frontmatter `date:`.            |
| `corpus/<subject>/superseded/*.md` | Older generations of a current document, with the **same file name**. |
| `bank.json`                        | The questions. Validated on load by `bank.ts`.                        |
| `grade.ts`                         | The scorer.                                                           |
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

- **Answer.** Every `expect` pattern appears in the reply. For `absent`, the reply has to say the lake lacks the answer.
- **Stale rejection.** No `rejectTokens` value appears in a sentence that presents it as current. A sentence that marks the value as historical ("up from an earlier count of 82") is allowed. The marker only covers its own sentence. Sentences split on `.` but not on a decimal point, so the stale figure in "308.7 million" is still caught.
- **Citation.** With `{ citationStyle: 'indexed', citables }`, each `[N]` resolves to `citables[N-1]` (`promptMeta.citables`, whose document `title` is the file name). At least one marker has to resolve to `expectSource`. A marker outside `citables` fails the check (`dangling`), because the UI would render it as a chip that points at nothing. With `{ citationStyle: 'named' }`, the reply has to name the file, with or without the extension or hyphens.

The grader works on the words of the reply, like its siblings. An unusual paraphrase can slip past it, but a reply that states the stale value as the answer cannot.

## What runs where

| File            | Runs in CI | What it pins                                                                                                                                                                                                                                                                                  |
| --------------- | :--------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grade.test.ts` |    yes     | The grader, against fixture replies for every `kind`.                                                                                                                                                                                                                                         |
| `bank.test.ts`  |    yes     | The bank against the corpus. Each subject has at least 10 questions and at least 2 of each planted kind. Each expected value is in its current source. Each stale value is in an older-dated document, and that document has the same file name or a different one, as the row's `kind` says. |
