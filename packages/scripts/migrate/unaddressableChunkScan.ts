import { FabFile, FabFileChunk, mongoose } from '@bike4mind/database';
import { extractEmbeddedObjectIds, OBJECT_ID_HEX } from './unaddressableChunkIds';

/**
 * The two-gate scan behind 20260911120000_delete-unaddressable-fabfilechunks. Shared by the
 * migration (which deletes what it yields) and preview-unaddressable-fabfilechunks.ts (which only
 * counts), so the predicate deciding an irreversible delete cannot drift between the preview an
 * operator signs off on and the run that acts on it.
 */

/** Chunks read per page. Only `_id` and `fabFileId` are projected, but an offending value is a
 *  whole serialized document (~425 characters observed), so the page stays modest. */
export const PAGE_SIZE = 200;

/**
 * Server-side cap PER PAGE. The predicate's `$not`-regex arm produces no index bounds, so the plan
 * is an `_id` IXSCAN plus a FETCH of every document in the collection - vectors included - to
 * evaluate the residual. Measured on mongod 8.2: an explicit `hint` on `{fabFileId: 1, _id: 1}`
 * with an index-order sort still reports `docsExamined` equal to the full collection, so the cost
 * cannot be indexed away for this predicate as written.
 *
 * It CAN be removed by taking the regex off the server. `{fabFileId: {$type: 'string'}}` alone is
 * covered by that index, and applying the regex to the returned keys reports `docsExamined` 0. The
 * result set is not the same, though - it is strictly larger, because JS `$` does not match before
 * a trailing newline, so the covered form also catches the `<24hex>\n` values the PCRE gap below
 * leaves behind. Two traps if anyone takes it: the keyset must advance on the compound
 * `(fabFileId, _id)`, because paging on `_id` under a `fabFileId` sort silently skips most of the
 * collection and reports success, and the page size wants to be far larger, since the covered form
 * reads every string-valued row rather than only the matching ones. Not taken here because one
 * full pass completes well inside the budget below. Re-measure before assuming that still holds if
 * the collection grows by an order of magnitude.
 *
 * The budget is per page, and a complete pass over the largest deployment measured finished with
 * several times that much room, so it is a guard against a pathological plan rather than a limit
 * the normal path approaches.
 *
 * Timing out THROWS rather than returning short, and that is deliberate: migrationManager writes
 * the ledger row only after `up()` resolves, so a throw leaves the migration pending and re-runnable
 * (the predicate is re-evaluated fresh and a partial run converges). Swallowing the timeout would
 * mark a half-finished destructive sweep as applied.
 */
export const QUERY_TIMEOUT_MS = 120_000;

/**
 * Per-row candidate cap, and a fail-SAFE one: a value over the cap is KEPT unconditionally rather
 * than truncated. Truncating would risk dropping the one candidate that resolves, which is the
 * wrongful-delete this gate exists to prevent. It also bounds the per-page `$in`, which the
 * overlapping match would otherwise let a long hex blob inflate by its own length.
 */
export const MAX_CANDIDATES_PER_ROW = 256;

export interface ChunkScanPage {
  /** Rows failing BOTH gates. Safe to delete; the migration does, the preview does not. */
  deletable: mongoose.Types.ObjectId[];
  /** Rows failing gate 1 whose value still embeds a resolvable file id - a human decides these. */
  keptIds: string[];
  /** Rows read on this page, for progress reporting. */
  scanned: number;
  /** Keyset position reached, so a timeout is diagnosable rather than just slow. */
  lastId: mongoose.Types.ObjectId;
}

/**
 * Yields one page at a time so the caller can act between pages. Keyset paging on `_id` rather than
 * a live cursor: the migration deletes out from under itself, and a kept row must not be revisited
 * forever.
 */
export async function* scanUnaddressableChunks(): AsyncGenerator<ChunkScanPage> {
  // Raw driver collections, not the models: the chunk values this matches are exactly the ones the
  // schema now rejects, and FabFile's soft-delete middleware would hide the very rows gate 2 needs
  // to see.
  const chunks = FabFileChunk.collection;
  const fabFiles = FabFile.collection;

  let afterId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    const page = await chunks
      .find(
        {
          $and: [
            { fabFileId: { $type: 'string' } },
            // `$type: 'string'` alone does NOT mean "the field is a string": on an array it matches
            // if ANY element does, so an array value would clear gate 1 and then be stringified into
            // a comma-joined blob. This is the only form that excludes arrays - `$type: 2` is an
            // alias for `'string'`, not a narrowing.
            { fabFileId: { $not: { $type: 'array' } } },
            // Server-side this is PCRE, where an unanchored `$` also matches before a trailing
            // newline - so a `<24hex>\n` value reads as addressable here and is left alone, while
            // the schema validator and `isObjectIdOrHexString` both reject it. Over-keeping, which
            // is the safe direction, but it is why the sweep is not exhaustive.
            { fabFileId: { $not: OBJECT_ID_HEX } },
            ...(afterId ? [{ _id: { $gt: afterId } }] : []),
          ],
        },
        { projection: { _id: 1, fabFileId: 1 }, sort: { _id: 1 }, limit: PAGE_SIZE, maxTimeMS: QUERY_TIMEOUT_MS }
      )
      .toArray();
    if (page.length === 0) return;
    afterId = page[page.length - 1]._id as mongoose.Types.ObjectId;

    const keptIds: string[] = [];
    const embeddedByRow = new Map<string, string[]>();
    for (const row of page) {
      const embedded = extractEmbeddedObjectIds(String(row.fabFileId));
      if (embedded.length > MAX_CANDIDATES_PER_ROW) {
        keptIds.push(String(row._id));
        continue;
      }
      embeddedByRow.set(String(row._id), embedded);
    }

    // One lookup per page over the union of candidates, including soft-deleted rows - a row whose
    // file is merely soft-deleted is still re-associable, so it is not this migration's to remove.
    const candidateIds = new Set([...embeddedByRow.values()].flat());
    const resolvable = new Set<string>();
    if (candidateIds.size > 0) {
      const found = await fabFiles
        .find(
          { _id: { $in: [...candidateIds].map(id => new mongoose.Types.ObjectId(id)) } },
          { projection: { _id: 1 }, maxTimeMS: QUERY_TIMEOUT_MS }
        )
        .toArray();
      for (const doc of found) resolvable.add(String(doc._id));
    }

    const deletable: mongoose.Types.ObjectId[] = [];
    for (const row of page) {
      const embedded = embeddedByRow.get(String(row._id));
      if (!embedded) continue; // over the candidate cap; already kept above.
      if (embedded.some(id => resolvable.has(id))) keptIds.push(String(row._id));
      else deletable.push(row._id as mongoose.Types.ObjectId);
    }

    yield { deletable, keptIds, scanned: page.length, lastId: afterId };
  }
}
