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
| A: capture | `capture-embeddings.ts` | live Mongo + provider key | no |
| B: analysis | `model-comparison.ts` | a fixture file | yes |

The capture embeds each chunk once per model **at full width** and writes a fixture. Everything after
that is arithmetic:

- **Widths are free.** `text-embedding-3-*` are Matryoshka models, so `3-small@1536/512` and
  `3-large@3072/1536/512` are five arms off two API calls. No width costs an extra request.
- **Nothing is written to Mongo.** No scratch lake, no persisted vector. That also disposes of a real
  hazard: `FabFile.embeddingModel` records the model with **no width**, so two vectors both honestly
  labelled `text-embedding-3-small` at 1536 and 512 would compare as noise. Nothing is stored here, so
  nothing can be mislabelled.
- **Exact cosine, not ANN.** The comparison scores every chunk through the shipped
  `computeCosineSimilarity`. The subject of the measurement is the embedding space, and ANN recall
  would be a confound on top of it. This is a real difference from the published prod numbers, which
  came through Atlas `$vectorSearch` - say so in any write-up.

## Running it

### 1. Baseline (ada-002), ~free

Reuses the corpus's existing vectors; only the 31 probe questions are embedded.

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
harness. A model with no published rate **aborts** rather than quoting $0.

### 3. Score every arm

```bash
pnpm --filter @bike4mind/scripts retrieval:model-comparison \
  --fixtures packages/scripts/out/text-embedding-ada-002.system-help.fixture.json,packages/scripts/out/text-embedding-3-small.system-help.fixture.json,packages/scripts/out/text-embedding-3-large.system-help.fixture.json \
  --widths 3072,1536,512
```

A width wider than a capture is skipped, so one `--widths` list covers every arm.

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

## Reading the output

Each arm prints a block shaped like the published prod probe, then one cross-arm table.

| column | meaning |
|---|---|
| `band min/max/width` | where the served scores sit, pooled across queries. The collapse this exists to measure. |
| `spread` | mean rank-1 minus rank-10. Near zero means the ranking carries no information. |
| `posTop` / `negTop` | mean rank-1 cosine on answerable vs unanswerable questions. Their **gap** is the floor headroom. |
| `recall`/`prec`/`hit`/`mrr` | did the wider band actually buy better retrieval, or just rescale the same ordering? |

`retrieval_unavailable` and `superseded` print as `n/a`, not `0`: this instrument has no indexing state
and runs no collapse pass, so claiming it checked and found none would be untrue.

`falsePositiveRate` is deliberately **not** a column. An offline top-k applies no similarity floor, so
it is structurally 1.0 for every arm. `negTop` is the number that can actually move, and it is what a
later re-derivation of the ada-002-era cosine literals needs.

### Two warnings the report raises for you

- **`ARMS COVER DIFFERENT CHUNK SETS`** - the `--reuse-stored-vectors` baseline keeps only chunks whose
  stamp names its model, while an embedded arm covers the whole lake. When the counts differ, the bands
  describe different corpora and band width is not directly comparable across them. Check `skipped`
  before drawing a model conclusion.
- **`GROUND TRUTH DOES NOT DESCRIBE THIS CORPUS`** - `corpus.ts` names help slugs, so a capture of any
  other lake matches nothing and the quality columns render `n/a`. The geometry columns need no labels
  and stay valid. This is the expected state for a production-lake arm.

### The go signal

From the issue: the band widening from ~0.058 to real separation, and the rank-1 to rank-10 spread
growing **by an order of magnitude** off ~0.014. A model that widens the band without improving
`mrr`/`recall` has bought nothing - which is why both halves sit in one table.

`3-large@1536` is a first-class arm. Truncated to 1536 it costs exactly the storage of `3-small@1536`
and every cosine is the same width, so the only remaining difference is the one-off embed price
(~6.5x). If it wins on separation, the cost argument against `3-large` largely dissolves.

## Results

No credentialed run has happened yet. **Do not fill this in from memory or estimate any cell** - the
whole point of the harness is that the numbers come from a measurement.

| arm | chunks | band min | band max | width | spread | posTop | negTop | recall | mrr |
|---|---|---|---|---|---|---|---|---|---|
| `text-embedding-ada-002@1536` (baseline) | | | | | | | | | |
| `text-embedding-3-small@1536` | | | | | | | | | |
| `text-embedding-3-small@512` | | | | | | | | | |
| `text-embedding-3-large@3072` | | | | | | | | | |
| `text-embedding-3-large@1536` | | | | | | | | | |
| `text-embedding-3-large@512` | | | | | | | | | |

## Out of scope

This harness measures. It does not change anything. Flipping `defaultEmbeddingModel`, re-embedding the
production corpus, re-tuning any cosine floor, and widening the FAB chunk stamp are all later steps
that depend on this result.

## Verifying the harness itself

```bash
pnpm --filter @bike4mind/scripts test retrieval/
pnpm --filter @bike4mind/scripts typecheck
```

`fixtures/tiny-comparison.fixture.json` is a 16-dim **synthetic** capture with a planted topical
structure. It exercises the truncation, the scoring and the rendering end to end without credentials.
No number it produces is a measurement of any embedding model.
