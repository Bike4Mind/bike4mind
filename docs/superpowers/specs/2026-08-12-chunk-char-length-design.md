# Chunk Character Length + Per-File Text Length (with Backfill) - Design

**Issue:** #1665 (lane B2 of the Data Lakes productization epic #1658). Prerequisite for derived
lake health (#1666).

## Problem

The health predicates in #1658 are stated in characters, because the serve cap is. The data to
compute them does not exist:

- `IFabFileChunk` is `{fabFileId, text, tokenCount, vector?, embeddingModel?}` - no character
  length. `tokenCount` is not a substitute: wrong unit, and the chars-per-token ratio swings by
  corpus, so a customer-facing percentage derived from it is systematically wrong per lake.
- No per-file extracted-text length is stored (`fileSize` is source bytes; `extractedCharCount`
  is a lazily-written cache from a different extractor - see "Why not extractedCharCount" below).
- `IDataLake` caches only `fileCount` and `totalSizeBytes` - both storage facts.

Computing health as specified today would mean reading `text` for every chunk of every file in a
lake, out of the collection that also holds `vector`. Fine at hundreds of chunks; ruinous as a
product feature on a connector-fed lake.

## Design

Three fields, one naming family, each derived from the one below it:

| Level | Field | Meaning |
|---|---|---|
| Chunk | `IFabFileChunk.charLength?: number` | Length of `text` in Unicode code points |
| File | `IFabFile.chunkedCharCount?: number \| null` | Sum of the file's chunk `charLength`s, stamped at chunk time |
| Lake | `IDataLake.totalChunkedChars?: number` | Sum of `chunkedCharCount` over the lake's live files |

All three are optional in the types because legacy documents lack them until the backfill runs;
every write path populates them unconditionally.

### Unit: Unicode code points, not UTF-16 code units

`charLength` counts code points (what MongoDB's `$strLenCP` returns), not `text.length` (UTF-16
code units). Reason: the backfill can then be a server-side pipeline update - chunk text never
leaves the database - and the live write path and the backfill compute exactly the same number.
The write path uses a small helper that iterates the string by code points.

The two units differ only on astral characters (surrogate pairs, e.g. emoji). The health
predicates that consume these numbers are advisory (#1658 settled decision 8), so that
discrepancy against any UTF-16-based serve-cap slice is immaterial. The field comment documents
the unit.

### Why not extractedCharCount

`IFabFile.extractedCharCount` already exists but is a different number with a different
lifecycle: it is measured by `getFileContent()` (`b4m-core/utils/src/fabfile.ts`), written
lazily by the composer's context dry-run route, and invalidated by content edits. `SmartChunker`
extracts text independently (its own PDF/DOCX/XLSX parsing), so the two totals legitimately
drift. Reusing the field would have two extractors overwriting each other with different
numbers. It stays untouched.

## Write paths

There are exactly two production doors that insert chunks; both gain the fields.

### 1. `chunkFabfile` (primary door)

`b4m-core/services/src/fabFileService/chunk.ts` maps `SmartChunker` output into chunk documents
before `db.fabFileChunks.bulkInsert(...)`. That map gains `charLength: countCodePoints(chunk.text)`.
The file stamp rides the `db.fabFiles.update(fabFile)` the function already performs for
chunk-count bookkeeping (chunkCount, chunked, embeddingModel - just before the old chunks are
deleted): `fabFile.chunkedCharCount = sum(charLength over the new chunks)` is set alongside
`fabFile.chunkCount`.

`countCodePoints` is a tiny exported helper (in `b4m-core/common`, next to the chunk types) so
the service, the help-ingest script, and tests share one definition.

### 2. `ingest-help-datalake.ts` (secondary door)

`packages/scripts/help/ingest-help-datalake.ts` builds chunk payloads with its own
heading-based splitter. Its payload builder gains the same `charLength`, and the FabFile it
creates gets `chunkedCharCount` stamped the same way.

### Non-doors, checked

- `vectorize.ts` updates an already-inserted chunk with `vector`/`embeddingModel` only - it
  round-trips whatever `charLength` the document has. No change.
- Connector ingestion (Slack et al.) writes bytes to storage and rides the same
  `objectCreated -> SQS -> chunkFabfile` pipeline. Covered by door 1.

## Lake rollup

`computeDataLakeStats` (`packages/database/src/models/content/FabFileModel.ts`) - the single
authoritative aggregate behind every lake-stats recompute - gains a third sum:
`totalChunkedChars: { $sum: { $ifNull: ['$chunkedCharCount', 0] } }` over the same live-file
match (`deletedAt: null, archivedAt: null, status != pending`). `DataLakeModel.setStats` and the
`IDataLakeRepository.setStats` contract widen to carry it.

All existing `recomputeLakeStats` call sites (~15: tag toggles, archive/unarchive/restore,
file removal, batch reconciliation, upload completion, migrations) pick the new field up
automatically. The "never increment, always re-derive" pattern is preserved; no new call sites.

## Invalidation

`FAB_FILE_CONTENT_REWRITE_PATCH` (`b4m-core/common/src/types/entities/FabFileTypes.ts`) gains
`chunkedCharCount: null`. Every AI content-rewrite site already spreads this patch, so a rewrite
nulls the stale sum and the re-chunk that follows the content upload re-stamps it. The
invalidation guard test (`b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts`)
extends to assert the new key.

Re-chunking needs no special handling: `chunkFabfile` deletes all chunks and re-inserts, then
stamps the fresh sum.

## Backfill

Standalone script `packages/scripts/datalake/backfill-chunk-char-length.ts`, modeled on
`backfill-chunk-embedding-model.ts`: dry-run by default, `--execute` to write, idempotent and
resumable (each phase's query only matches documents still missing the field). Run via
`npx sst shell --stage <stage> -- tsx ...`. A standalone script rather than a migration because
it is a bounded one-time sweep over existing data and must not gate a deploy.

Three phases, each independently resumable:

1. **Chunks.** Page `_id`s where `charLength: { $exists: false }` (keyset on `_id`), then per
   batch: `updateMany({ _id: { $in: batch } }, [{ $set: { charLength: { $strLenCP: '$text' } } }])`.
   The pipeline update computes the length server-side - no chunk text is transferred.
2. **Files.** For FabFiles missing `chunkedCharCount` that have chunks, aggregate the per-file
   sum over the `{fabFileId: 1, _id: 1}` index and `$set` it.
3. **Lakes.** Iterate all lakes and call the existing `recomputeLakeStats`, which now includes
   `totalChunkedChars`.

Dry-run reports counts per phase (chunks/files/lakes pending) without writing.

## Schema changes

`packages/database/src/models/content/FabFileModel.ts`:
- `FabFileChunkSchema`: `charLength: { type: Number }` (not required - legacy docs).
- `FabFileSchema`: `chunkedCharCount: { type: Number }` (nullable via the rewrite patch).

`packages/database/src/models/ai/DataLakeModel.ts`:
- `totalChunkedChars: { type: Number, default: 0 }`.

No new indexes: none of the new fields is queried on a hot path. The backfill's
`$exists: false` scans are one-time and keyset-paged.

## Testing

- `packages/database` (via `createMongoServer()`):
  - `computeDataLakeStats` sums `chunkedCharCount`, treating missing values as 0 and excluding
    deleted/archived/pending files.
  - Backfill phase 1 pipeline update: `$strLenCP` result matches `countCodePoints`, including a
    multi-byte/astral-character case; already-stamped chunks are not rewritten (idempotence).
- `b4m-core/services`: `chunkFabfile` unit test - chunks reach `bulkInsert` with `charLength`,
  and the file update carries the correct `chunkedCharCount` sum.
- `b4m-core/common`: `countCodePoints` unit test (ASCII, BMP, astral).
- Guard test extension: `FAB_FILE_CONTENT_REWRITE_PATCH` includes `chunkedCharCount: null`.

## Out of scope

- The health predicates themselves and any health UI (#1666).
- Re-chunking or repairing badly-chunked content (#1684, #1662). This is a metadata backfill
  only, explicitly outside #1658's "migration of existing lake data" exclusion.
- Serve-cap changes (#1661).
- New indexes or query-path changes.
