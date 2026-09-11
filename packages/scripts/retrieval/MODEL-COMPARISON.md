# Embedding-model comparison for the FAB/RAG corpus

Measures the **score distribution** of a real data lake under several embedding models and
Matryoshka widths, so the corpus migration off `text-embedding-ada-002` picks its model and width
from a measurement rather than by inheritance.

## Why this exists

Measured on a production lake, the FAB/RAG corpus under ada-002 collapses into a narrow cosine band
(0.8272 - 0.8856, width 0.058) with rank-1 and rank-10 separated by ~0.014. The retriever returns ten
passages it cannot meaningfully rank, and any threshold placed in that band is deciding on the fourth
decimal place.

The obvious replacement, `text-embedding-3-small`, was chosen against the **Mementos** corpus: short
facts, already at MRR 1.000. The stated argument for it over `3-large` is that "the extra capacity is
for long/hard documents, not short facts" - which is precisely the argument that does **not** transfer
to the FAB corpus's ~2200-char prose passages, roughly 12 per file. So the model question is open, and
this harness answers it before anyone pays for a corpus re-embed.

## How it is split, and why

| phase | script | needs | runs in CI |
|---|---|---|---|
| A: capture | `capture-embeddings.ts` | live Mongo (+ provider key to embed) | no |
| B: analysis | `model-comparison.ts` | a fixture file | yes |

`--dry-run` returns before the provider key is resolved, so the price quote and the corpus-regime gate
both run on Mongo alone: you can price the run and confirm the lake is in the long-document regime
*before* going to get a key or authorising any spend, which is the order this runbook wants.

The capture embeds each chunk once per model **at full width** and writes a fixture. Everything after
that is arithmetic:

- **Widths are free.** `text-embedding-3-*` are Matryoshka models, so `3-small@1536/512` and
  `3-large@3072/1536/512` are five arms off two API calls. No width costs an extra request.
- **Nothing is written to the corpus.** No scratch lake, no persisted vector. (`connectDB` itself is
  not write-free - it seeds the price catalog and builds indexes on first connect, same as any deploy
  boot - see the script's docblock.) That also disposes of a real hazard: `FabFile.embeddingModel`
  records the model with **no width**, so two vectors both honestly labelled `text-embedding-3-small`
  at 1536 and 512 would compare as noise. Nothing is stored here, so nothing can be mislabelled.
- **Exact cosine, not ANN.** The comparison scores every chunk through the shipped
  `computeCosineSimilarity`. The subject of the measurement is the embedding space, and ANN recall
  would be a confound on top of it. This is a real difference from the published prod numbers, which
  came through Atlas `$vectorSearch` - say so in any write-up.

## Running it

### 1. Baseline (ada-002), ~free

Reuses the corpus's existing vectors; only the 30 probe questions are embedded.

```bash
npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/capture-embeddings.ts \
  --lake system-help --userId <userId> \
  --models text-embedding-ada-002 --reuse-stored-vectors
```

This arm is the **instrument check**. If it cannot reproduce a ~0.06-wide band over a real
long-document lake, the harness is wrong and no verdict from it counts.

### 2. Price the candidates, then run them

```bash
# read the cost first
npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/capture-embeddings.ts \
  --lake system-help --userId <userId> \
  --models text-embedding-3-small,text-embedding-3-large --dry-run

# then approve it
npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/capture-embeddings.ts \
  --lake system-help --userId <userId> \
  --models text-embedding-3-small,text-embedding-3-large --yes
```

Cost is priced from the shipped rate table (`getEmbeddingModelCost`), never from a literal in this
harness. On an embedding run, a model with no published rate **aborts** rather than quoting $0.
(`--reuse-stored-vectors` embeds only the probe queries, which the plan output already calls rounding
error, so it has no rate to check.) Any chunk over the provider's per-input token ceiling aborts here
too, naming the chunk - the batcher's own check fires only after the spend is approved.

### 3. Score every arm

```bash
pnpm --filter @bike4mind/scripts retrieval:model-comparison \
  --fixtures out/text-embedding-ada-002.system-help.fixture.json,out/text-embedding-3-small.system-help.fixture.json,out/text-embedding-3-large.system-help.fixture.json \
  --widths 3072,1536,512
```

Paths are relative to `packages/scripts/`, which is the cwd `pnpm --filter` runs in and where step 1
and step 2 wrote their fixtures (`--out-dir` defaults there). Steps 1 and 2 run from the repo root, so
their paths are repo-root-relative; this one is not.

A width wider than a capture is skipped, so one `--widths` list covers every arm - but a fixture with
no applicable width at all **aborts** rather than quietly dropping out of the table. Only
`text-embedding-3-small` and `text-embedding-3-large` are Matryoshka, so only they yield width arms -
the ada-002 baseline is scored at its capture width alone whatever `--widths` says, and the report
notes it.

## The corpus-regime gate

The capture prints the chunk char-length distribution and chunks-per-file before spending anything,
against the prod reference (~12 chunks/file, median 2182 chars).

**This is a gate, not a footnote.** If the source corpus is not in the long-document regime, it cannot
answer the question this comparison asks, and a model verdict read off it inherits the very bias the
comparison exists to remove. The capture says so in the clear; discard the verdict and capture a
production lake instead.

`system-help` (51 committed articles, seeded by `packages/scripts/help/ingest-help-datalake.ts`) is the
**reproducible** arm - it is public and in-repo, so anyone can re-derive the result. A production lake
is the **confirmatory** arm, and a human has to name it and authorise the spend.

Two things about that confirmatory arm:

- **Name it by `datalakeTag`, not by slug.** A slug is unique only per organization, and this script
  resolves one with no org context - which reaches an org-less lake like `system-help` and no
  org-owned lake at all. `--lake` accepts either and tries the slug first; an org-owned production
  lake needs its globally-unique `datalakeTag`.
- **Pass your own `--userId`.** It decides whose credential pays: `getEffectiveLLMApiKeys` prefers a
  personal key over the platform one, so passing the lake owner's id spends a third party's quota.
  The preflight prints the resolved source (`credential source`) before it embeds - read that line.

## Reading the output

Each arm prints a block shaped like the published prod probe, then one cross-arm table.

| column | meaning |
|---|---|
| `band min/max/width` | where the served scores sit, pooled across queries. The collapse this exists to measure. |
| `spread` | mean rank-1 minus rank-N, where N is the printed `rankDepth` (`RANK_DEPTH`, or fewer on a small corpus). Near zero means the ranking carries no information. |
| `posTop` / `negTop` | mean rank-1 cosine on answerable vs unanswerable questions. Their **gap** is the floor headroom. |
| `recall`/`prec`/`hit`/`mrr` | did the wider band actually buy better retrieval, or just rescale the same ordering? |

The last six columns all read `n/a` when no captured document matches a supporting slug in `corpus.ts`
(the report says so in a note). `posTop`/`negTop` are partitioned by `supporting.length`, so on a lake
the ground truth does not describe, the "positive" and "negative" halves are an arbitrary split and
their gap is noise. `band` and `spread` need no labels and stay valid.

PARTIAL overlap gets its own note, because the all-or-nothing check above passes on it: a lake sharing
one supporting slug renders a full set of quality columns computed against the whole supporting set,
so `recall` and `prec` are bounded well below 1 by the corpus rather than by the model. The note states
the fraction (`3 of 49 supporting documents captured`); compare arms to each other, not to 1.

Each arm block prints the band **twice**. `overall band` is pooled across every probe question,
including the 5 deliberate negatives; `positives-only band` is the same statistic over the answerable
questions alone. Read the instrument check against the second one: the published prod figure
(0.8272 - 0.8856) was measured over that lake's **relevant** queries, and a band is `max - min`, so
pooling in a negative's top score is exactly the kind of difference an extreme carries. The go signal
is unaffected either way - every arm shares one question set - so for comparing arms to each other,
either band works.

`retrieval_unavailable` is a real number: the capture enumerates the lake with the lifecycle-sweep
reader (which returns every id the lake has ever held) and then filters it to the files retrieval can
reach - live, not archived, not retrieval-excluded, `vectorizedChunkCount >= chunkCount > 0`.
That count is the files it dropped. The predicate mirrors the shipped `isFabFileCitable` minus its
`embeddingModel` clause, which the arms deliberately vary.

It is the CITATION bar, which on one point is stricter than what the vector read actually returns, so
this counter **overstates** production's withheld count and the band is measured over a slightly
narrower corpus. The partially-vectorized file is the case: `partitionByIndexAvailability`
(b4m-core/services/src/dataLakeService/retrievalUnavailable.ts) withholds a file only when it is marked
stalled with nothing vectorized, or its indexing is in flight, and its docblock says outright that "a
partially vectorized file (40 of 90) really does return its embedded passages, so it ranks normally" -
because the read filters `vector: {$exists, $ne: []}` per CHUNK, not per file.

The corpus defer gate (`ChatCompletionProcess.resolveCorpusInlinePlan`) does treat
`vectorizedChunkCount >= chunkCount` as the condition for the semantic arm reaching a doc, so the two
shipped sites do not read the same on this file. That gate can afford to be conservative - being wrong
there only means inlining a doc it could have deferred - while the partition is the one describing what
comes back. Taking the partition as the truth is what makes this an overstatement rather than an
undercount.

Every arm shares one filter, which makes the drop neutral for a **mean** - but band width is
`max - min`, an extreme, and the withheld stratum is not random (a partially vectorized file skews
long, and this comparison exists because model behaviour may interact with length). So the rider is
narrower than "unaffected": **the comparison is unbiased when `retrieval_unavailable` is 0**, which
every arm block prints. On the corpus this targets it is 0 - the prod probe recorded zero missing
vectors and zero paused or indexing files. Read the counter before reading the widths against each
other.

`superseded` prints as `n/a`, not `0`: this instrument runs no collapse pass, so claiming it checked
and found none would be untrue.

`falsePositiveRate` is deliberately **not** a column. An offline top-k applies no similarity floor, so
it is structurally 1.0 for every arm. `negTop` is the number that can actually move, and it is what a
later re-derivation of the ada-002-era cosine literals needs.

### Five warnings the report raises for you

- **`ARMS COVER DIFFERENT CHUNK SETS`** - the `--reuse-stored-vectors` baseline keeps only chunks whose
  stamp names its model, while an embedded arm covers the whole lake. When the counts differ, the bands
  describe different corpora and band width is not directly comparable across them. Check `skipped`
  before drawing a model conclusion.
- **`GROUND TRUTH DOES NOT DESCRIBE THIS CORPUS`** - `corpus.ts` names help slugs, so a capture of any
  other lake matches nothing and the quality columns render `n/a`. The geometry columns need no labels
  and stay valid. This is the expected state for a production-lake arm.
- **`GROUND TRUTH ONLY PARTLY DESCRIBES THIS CORPUS`** - some supporting documents are captured and
  some are not, which the flag above does not catch. The quality columns are real numbers, just capped
  by the corpus; the note gives the fraction so nobody reads a low `recall` as a model verdict.
- **`NOT THE LONG-DOCUMENT REGIME`** - the corpus-regime gate, restated here as well as on the
  capture's stdout, because whoever scores the fixtures later sees only this report. Discard the model
  verdict and capture a production lake.
- **`SCORED AT CAPTURE WIDTH ONLY`** - a capture this harness will not truncate ignored `--widths`
  entirely. For ada-002, Bedrock and Ollama that is because a prefix of one of those vectors is not an
  embedding at all. `voyage-3-large` is the one exception worth knowing: it does ship MRL widths, but
  they come from the provider's own `output_dimension` at embed time, so a Voyage width arm has to be
  captured rather than derived.

### The go signal

From the issue: the band widening from ~0.058 to real separation, and the rank-1 to rank-10 spread
growing **by an order of magnitude** off ~0.014. A model that widens the band without improving
`mrr`/`recall` has bought nothing - which is why both halves sit in one table.

`3-large@1536` is a first-class arm. Truncated to 1536 it costs exactly the storage of `3-small@1536`
and every cosine is the same width, so the only remaining difference is the one-off embed price
(~6.5x). If it wins on separation, the cost argument against `3-large` largely dissolves.

## Results

Captured 2026-09-11 against the `system-help` lake on the `dev` (staging) stage: 51 capturable files,
452 chunks, 62 files unreachable by the served path. The baseline reused the corpus's stored ada-002
vectors (0 excluded - no unlabeled, mismatched, missing or wrong-width vector), and both candidates
were embedded fresh for $0.0140 total. Scores are exact cosine, NOT the ANN path prod measures
through.

**This corpus is NOT in the long-document regime** (median chunk 638 chars against the prod reference
of 2182), so read the table for what it can support and no further - see the findings below.

| arm | chunks | band min | band max | width | spread | posTop | negTop | recall | prec | hit | mrr |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `text-embedding-ada-002@1536` (baseline) | 452 | 0.7191 | 0.8110 | 0.0918 | 0.0279 | 0.7699 | 0.7647 | 0.910 | 0.295 | 1.000 | 0.707 |
| `text-embedding-3-small@1536` | 452 | 0.2293 | 0.5588 | 0.3294 | 0.0968 | 0.4269 | 0.3615 | 0.867 | 0.353 | 1.000 | 0.897 |
| `text-embedding-3-small@512` | 452 | 0.2608 | 0.5719 | 0.3111 | 0.0940 | 0.4619 | 0.3939 | 0.833 | 0.306 | 0.960 | 0.843 |
| `text-embedding-3-large@3072` | 452 | 0.2104 | 0.5197 | 0.3093 | 0.0984 | 0.4031 | 0.3246 | 0.877 | 0.338 | 1.000 | 0.890 |
| `text-embedding-3-large@1536` | 452 | 0.2161 | 0.5430 | 0.3269 | 0.0977 | 0.4261 | 0.3499 | 0.843 | 0.323 | 1.000 | 0.890 |
| `text-embedding-3-large@512` | 452 | 0.2458 | 0.5946 | 0.3488 | 0.0973 | 0.4599 | 0.3761 | 0.843 | 0.336 | 1.000 | 0.845 |

`prec` and `hit` are added to the columns this section originally listed: the harness prints both, and
`hit` is what carries the truncation finding below.

### SETTLED: ada-002 loses on every axis that matters

Band width 3.5x, rank-1-to-rank-10 spread 3.5x, MRR 0.707 -> 0.897. The decisive one is the gap between
`posTop` and `negTop` - how far a real answer outscores the best false lead on a question the corpus
cannot answer:

| arm | posTop - negTop |
|---|---|
| `ada-002@1536` | **0.0052** |
| `3-small@1536` | 0.0654 |
| `3-small@512` | 0.0680 |
| `3-large@1536` | 0.0762 |
| `3-large@3072` | 0.0785 |
| `3-large@512` | 0.0838 |

Every 3-* arm separates answerable from unanswerable 12-16x better than ada-002, whose 0.0052 leaves no
absolute floor able to tell them apart at all. This conclusion does not depend on the corpus regime.

ada-002 does win `recall` (0.910 against 0.867). With `hit` at 1.000 for both that edge buys little - it
drags more of the supporting set into the top 10 while ranking it worse - but it belongs in the table
rather than dropped.

### NOT SETTLED: 3-small against 3-large

They are within noise of each other here, and `3-small` costs 6.5x less - which is exactly the tempting
conclusion this corpus cannot support. At a 638-char median this run reproduces the short-text regime
the Mementos table was already in, where small ties large for the stated reason that the extra capacity
is for long documents. Untested, not refuted. **Do not record a model verdict from this run.**

### NEW: 512-dim truncation is not free at this chunk size

Mementos measured 512 lossless on short facts (`b4m-core/memory/src/eval/dimensions.test.ts`). Here it
costs real quality: `3-small` MRR 0.897 -> 0.843 and hit 1.000 -> 0.960, `3-large` MRR 0.890 -> 0.845.
`3-small@512` is the only arm in the table that fails to place a supporting document in the top 10 for
every question. Two points now sit on that curve - lossless at memento length, lossy at 638 chars - and
the FAB corpus at 2182 chars sits further along the same axis, so expect the loss to grow rather than
shrink. Directional, not proven.

### NEW: what the measured bands do to the live cosine floors

`3-small@1536` spans 0.2293-0.5588 and `3-large@3072` spans 0.2104-0.5197. The `0.75` floors in
`forcedRetrieval.ts`, `ChatCompletionFeatures.ts` and `getFirstIterationMementosPreamble.ts` sit ABOVE
the whole band in either space, so after the flip they reject every chunk on every query - the silent
outage `b4m-core/common/src/schemas/embedding.ts` records this codebase hitting twice already.

A FAB replacement floor is bracketed by `posTop` and `negTop`: roughly 0.38-0.40 for `3-small@1536`.
That is NOT `MEMENTO_MIN_SIMILARITY` (0.25), which sits below this corpus's `negTop` of 0.3615 and would
admit the noise. The memento floor does not transfer to the file corpus.

`FORCED_RETRIEVAL_RELATIVE_FLOOR_PCT_DEFAULT` (85) changes character on the flip. Under ada-002 a
per-turn spread of 0.0279 against a top near 0.77 puts rank 10 at ~96% of rank 1, so 85 rejects nothing.
Under `3-small` a spread of ~0.097 against a top near 0.43 puts rank 10 near 78%, so 85 begins cutting
around rank 5-6. Given precision of 0.35 that may well be an improvement, but it is a dormant gate
switching on rather than a no-op, and it is the opposite direction from the "tune it UPWARD" note at its
definition.

## Out of scope

This harness measures. It does not change anything. Flipping `defaultEmbeddingModel`, re-embedding the
production corpus, re-tuning any cosine floor, and widening the FAB chunk stamp are all later steps
that depend on this result.

## Verifying the harness itself

```bash
pnpm --filter @bike4mind/scripts test retrieval/
pnpm --filter @bike4mind/scripts typecheck
pnpm --filter @bike4mind/scripts retrieval:model-comparison \
  --fixtures retrieval/fixtures/tiny-comparison.fixture.json --widths 16,8
```

`fixtures/tiny-comparison.fixture.json` is a 16-dim **synthetic** capture with a planted topical
structure. It exercises the truncation, the scoring and the rendering end to end without credentials.
No number it produces is a measurement of any embedding model.
