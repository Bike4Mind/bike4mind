import { FeedbackTextModel } from '@bike4mind/database';

/**
 * Re-attach the reporter's free text to already-redacted feedback rows (#1864).
 *
 * The text lives in the TTL'd `FeedbackText` sibling collection so it can expire on its own, which
 * means every read path has to join it back for the client contract to stay unchanged. Batched into
 * one `$in` query rather than a per-row lookup, since the admin list returns the whole collection.
 *
 * TWO ARMS, and the second one is temporary. A row written after the split has its text in
 * `FeedbackText`; a row written BEFORE it still carries `content` on the document itself. Preferring
 * the sibling and falling back to the legacy field is what makes the deploy safe regardless of when
 * the operator runs the backfill migration - without the fallback, every historical report would
 * render blank in the admin console during that window. Drop the fallback once the backfill has run
 * everywhere and one retention window has passed.
 *
 * An ABSENT result is normal, not an error: past 90 days the text is gone by design and the
 * structured signal is all that remains. Callers must render a missing `content` rather than assume
 * a string - see the guard in useFeedbackFilters.
 */
export async function attachFeedbackText<T extends { id?: string; _id?: unknown; content?: string }>(
  rows: T[]
): Promise<T[]> {
  if (rows.length === 0) return rows;

  const idOf = (r: T) => String(r.id ?? r._id ?? '');
  const ids = rows.map(idOf).filter(Boolean);
  if (ids.length === 0) return rows;

  let byFeedbackId = new Map<string, string>();
  try {
    const texts = await FeedbackTextModel.find({ feedbackId: { $in: ids } })
      .select({ feedbackId: 1, content: 1 })
      .lean();
    byFeedbackId = new Map(
      (texts as Array<{ feedbackId: string; content: string }>).map(t => [String(t.feedbackId), t.content])
    );
  } catch {
    // A failed join must not 500 the console: fall through to whatever the rows already carry
    // (legacy `content` for pre-split rows, absent for the rest).
    return rows;
  }

  return rows.map(r => {
    const joined = byFeedbackId.get(idOf(r));
    // `r.content` is the legacy arm; only used when the sibling has nothing for this row.
    return joined === undefined ? r : { ...r, content: joined };
  });
}
