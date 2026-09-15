import { FabFileChunk, mongoose } from '@bike4mind/database';
import { MIN_CHUNK_CHARS_FLOOR } from '@bike4mind/common';

/**
 * The scan + planning logic behind the near-empty-chunk corpus sweep (#2817). Shared by the
 * migration (20260915120000_delete-near-empty-vectorized-fabfilechunks, which deletes what this
 * plans) and its read-only preview counterpart, so the predicate an operator signs off on cannot
 * drift from the one that acts on it - `collectNearEmptyCandidates` is the single entry point both
 * use, so the scan-then-group step is not reimplemented per caller either.
 *
 * Scoped to VECTOR-BEARING chunks only: a chunk with no vector yet is not competing for a
 * retrieval slot (the issue's own framing - these rows are "already vectorized" and "count toward
 * vectorizedChunkCount"). A vectorless degenerate chunk is deliberately left alone here - NOT
 * because an existing cycle will apply the producer's floor to it (an already-chunked file is
 * never re-chunked just because a vectorize message resumes; `chunkFile`/
 * `SmartChunker.mergeOrDropNearEmptyChunks` only run on ingest or an explicit "Rebuild passages")
 * - but because it has no retrieval slot to reclaim, so leaving it is strictly safer than widening
 * this one-time sweep's blast radius. It stays sub-floor until a re-chunk naturally passes it
 * through the fixed producer.
 *
 * The scan's `charLength: { $ne: null, ... }` arm deliberately excludes chunks that predate the
 * `charLength` backfill (packages/scripts/datalake/backfill-chunk-char-length.ts, a hand-run
 * script, not a registered migration): a charLength-less row is this sweep's not to judge, since
 * "under the floor" is meaningless without the field it is measured against. Those rows stay
 * invisible to both this scan and its preview until the backfill has run.
 */

/** Chunks read per scan page. Only three fields are projected, so a larger page than the
 *  unaddressable-chunk sweep's is cheap. */
export const PAGE_SIZE = 500;

/**
 * No index covers `charLength` (see packages/database/src/__tests__/fabFileChunkIndexes.test.ts,
 * which pins the schema's only compound index to `{ fabFileId: 1, _id: 1 }`), so this is a full
 * collection scan, same caveat as unaddressableChunkScan.ts. Per-call server timeout so a
 * pathological plan throws (leaving the migration re-runnable) rather than hangs.
 */
export const QUERY_TIMEOUT_MS = 120_000;

/** Distinct fabFileIds counted per batched aggregate call, in planNearEmptyChunkDeletions. */
export const COUNT_BATCH_SIZE = 500;

export interface NearEmptyChunkRow {
  _id: mongoose.Types.ObjectId;
  fabFileId: string;
  charLength: number;
}

export interface NearEmptyChunkScanPage {
  rows: NearEmptyChunkRow[];
  /** Keyset position reached, so a timeout is diagnosable rather than just slow. */
  lastId: mongoose.Types.ObjectId;
}

/**
 * Pages every vector-bearing chunk under MIN_CHUNK_CHARS_FLOOR, ascending by `_id`. Keyset paging
 * (not a live cursor) because deletes happen after the full candidate set is collected - see
 * collectNearEmptyCandidates - and a live cursor would be invalidated by those later deletes.
 *
 * Raw driver, not the model: this scan is keyed on `fabFileId` alone and never reads a FabFile
 * document, so no ODM middleware is relevant to it. The projection is intentionally minimal.
 */
export async function* scanNearEmptyChunks(): AsyncGenerator<NearEmptyChunkScanPage> {
  const chunks = FabFileChunk.collection;
  let afterId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    const page = await chunks
      .find(
        {
          charLength: { $ne: null, $lt: MIN_CHUNK_CHARS_FLOOR },
          'vector.0': { $exists: true },
          ...(afterId ? { _id: { $gt: afterId } } : {}),
        },
        {
          projection: { _id: 1, fabFileId: 1, charLength: 1 },
          sort: { _id: 1 },
          limit: PAGE_SIZE,
          maxTimeMS: QUERY_TIMEOUT_MS,
        }
      )
      .toArray();
    if (page.length === 0) return;
    afterId = page[page.length - 1]._id as mongoose.Types.ObjectId;

    yield {
      rows: page.map(row => ({
        _id: row._id as mongoose.Types.ObjectId,
        fabFileId: String(row.fabFileId),
        charLength: row.charLength as number,
      })),
      lastId: afterId,
    };
  }
}

/**
 * Runs the scan to completion and groups every candidate row by `fabFileId`. The single entry
 * point for both the migration and its preview, so a future change to the grouping (a per-file
 * cap, a skip rule) cannot land in one caller and silently miss the other.
 *
 * `onPage` is an optional progress callback (page number, rows scanned so far, keyset position) -
 * the two callers differ only in how they log it.
 */
export async function collectNearEmptyCandidates(
  onPage?: (info: { pages: number; scanned: number; lastId: mongoose.Types.ObjectId }) => void
): Promise<{ candidatesByFile: Map<string, NearEmptyChunkRow[]>; scanned: number; pages: number }> {
  const candidatesByFile = new Map<string, NearEmptyChunkRow[]>();
  let scanned = 0;
  let pages = 0;

  for await (const page of scanNearEmptyChunks()) {
    scanned += page.rows.length;
    pages += 1;
    for (const row of page.rows) {
      const existing = candidatesByFile.get(row.fabFileId);
      if (existing) existing.push(row);
      else candidatesByFile.set(row.fabFileId, [row]);
    }
    onPage?.({ pages, scanned, lastId: page.lastId });
  }

  return { candidatesByFile, scanned, pages };
}

export interface NearEmptyChunkFilePlan {
  fabFileId: string;
  /** Ids safe to delete for this file. */
  deletableIds: mongoose.Types.ObjectId[];
  /** Set when EVERY chunk this file has is a candidate - deleting all of them would leave
   *  `chunkCount` at 0, which reads downstream as "no extractable text" (NO_EXTRACTABLE_TEXT_NOTICE)
   *  rather than "hard to embed usefully". The kept id is the LEAST degenerate (highest
   *  charLength) of the file's candidates, and is excluded from `deletableIds`. */
  keptSoleChunkId?: mongoose.Types.ObjectId;
}

/**
 * Turns the raw candidate rows (grouped by file) into a final delete/keep decision per file. A
 * separate step from the scan because the "would this leave the file with zero chunks" check needs
 * the FULL candidate set for a file, which a single streamed page cannot guarantee it has seen.
 *
 * The "does this file have any OTHER (non-candidate) chunk" check is one batched aggregate over
 * every candidate fabFileId, not one `countDocuments` per file - the earlier per-file form was an
 * N+1 inside the deploy-gating migrator Lambda's 15-minute/512MB budget.
 */
export async function planNearEmptyChunkDeletions(
  candidatesByFile: Map<string, NearEmptyChunkRow[]>
): Promise<NearEmptyChunkFilePlan[]> {
  const chunks = FabFileChunk.collection;
  const fabFileIds = [...candidatesByFile.keys()];
  const totalChunksByFile = new Map<string, number>();

  for (let i = 0; i < fabFileIds.length; i += COUNT_BATCH_SIZE) {
    const batch = fabFileIds.slice(i, i + COUNT_BATCH_SIZE);
    const counts = await chunks
      .aggregate<{ _id: string; total: number }>(
        [{ $match: { fabFileId: { $in: batch } } }, { $group: { _id: '$fabFileId', total: { $sum: 1 } } }],
        { maxTimeMS: QUERY_TIMEOUT_MS }
      )
      .toArray();
    for (const row of counts) totalChunksByFile.set(row._id, row.total);
  }

  const plans: NearEmptyChunkFilePlan[] = [];
  for (const [fabFileId, rows] of candidatesByFile) {
    const totalChunks = totalChunksByFile.get(fabFileId) ?? rows.length;
    let toDelete = rows;
    let keptSoleChunkId: mongoose.Types.ObjectId | undefined;
    if (totalChunks === rows.length) {
      const sorted = [...rows].sort((a, b) => b.charLength - a.charLength);
      const [kept, ...rest] = sorted;
      keptSoleChunkId = kept._id;
      toDelete = rest;
    }
    plans.push({ fabFileId, deletableIds: toDelete.map(r => r._id), keptSoleChunkId });
  }

  return plans;
}
