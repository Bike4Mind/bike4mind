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
