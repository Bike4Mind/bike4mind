import { FeedbackTextModel } from '@bike4mind/database';
import { IFeedbackDocument, redactPromptMetaForViewer } from '@bike4mind/common';
import { HydratedDocument } from 'mongoose';

/**
 * Every feedback route an admin console reads/writes through (list, single read, update, delete)
 * must redact functionCalls[].returnValue the same way admin/model-logs.ts does - none of these
 * are a mechanism for a reporter to view their own submission back, so isOwner is always false
 * here. Centralized because the four call sites were carrying the identical two lines plus a
 * near-identical comment explaining the .toJSON() trap, which is exactly the drift
 * computeVerbatimTokenBudget was extracted elsewhere in this PR to prevent.
 *
 * .toJSON() first: spreading a hydrated Mongoose subdocument directly leaks the unredacted value
 * back in through its _doc/$__ internals.
 */
export function toRedactedFeedback(doc: HydratedDocument<IFeedbackDocument>) {
  const plain = doc.toJSON();
  return { ...plain, promptMeta: redactPromptMetaForViewer(plain.promptMeta, false) };
}

/**
 * Joins the TTL'd FeedbackText sibling back onto its owning report(s) - one batched lookup, never
 * N+1. `contentExpired` distinguishes "the 90-day TTL swept this row" from "this report never had
 * text" (contentStored is false in the latter case); both render as an absent `content`, so a
 * caller that needs to tell them apart must check this flag rather than infer it.
 *
 * Falls back to `item.content` when no sibling row exists: a document created before this split
 * (and not yet touched by the backfill migration) still carries its content directly, and
 * `contentStored` defaults to false on it via the schema default rather than being unset - without
 * this fallback, every pre-migration report's content would read as blank the moment this ships,
 * well before the migration ever runs.
 *
 * This fallback depends on `contentStored`'s schema default staying `false` (never made required
 * with no default) and on the migration only marking `contentStored: true` for a CONFIRMED sibling
 * copy (see the `confirmedIds` gate in the backfill migration) - if either changes, a legacy
 * pre-migration row could report `contentExpired` incorrectly. Not enforced at runtime since both
 * are currently guaranteed structurally; revisit this function if either guarantee moves.
 */
export async function hydrateFeedbackText<T extends { id: string; contentStored: boolean; content?: string }>(
  items: T[]
): Promise<Array<T & { content?: string; contentExpired: boolean }>> {
  if (items.length === 0) return [];

  const texts = await FeedbackTextModel.find({ _id: { $in: items.map(item => item.id) } }).lean();
  const contentById = new Map(texts.map(text => [text._id.toString(), text.content]));

  return items.map(item => {
    const siblingContent = contentById.get(item.id);
    const content = siblingContent ?? item.content;
    return { ...item, content, contentExpired: item.contentStored && content === undefined };
  });
}
