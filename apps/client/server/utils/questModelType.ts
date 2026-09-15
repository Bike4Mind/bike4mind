import { isPromptMetaModelType, type PromptMetaModelType } from '@bike4mind/common';

/**
 * Alias, not a redeclaration: the set of modalities a quest can report is exactly the set
 * promptMeta.model.type is allowed to hold, and ChatCompletionInvoke rejects anything wider at the
 * write. Keeping it an alias is what makes a `switch` over this union actually exhaustive.
 */
export type QuestModelType = PromptMetaModelType;

/**
 * Admin-metrics view of a quest's modality.
 *
 * `promptMeta.model.type` is authoritative whenever the writer recorded it, so attached images are
 * a fallback for rows that predate it rather than an override - treating images as an override
 * would report a video turn as an image, and the chars-per-second chart gates on `=== 'text'`.
 *
 * Shared by the analytics and model-metrics projections so the two cannot drift apart again.
 *
 * The stored value is screened rather than trusted: the Mongoose subschema is a bare String, and
 * rows written before the write path was constrained can carry a modality outside this union (a
 * completion dispatched against a speech-to-text id). Such a row falls through to the same
 * images/text fallback as a row that never recorded a type - unknown, not mislabelled.
 */
export function resolveQuestModelType(quest: {
  promptMeta?: { model?: { type?: string } | null } | null;
  images?: string[] | null;
}): QuestModelType {
  const stored = quest.promptMeta?.model?.type;
  if (stored && isPromptMetaModelType(stored)) return stored;
  return (quest.images?.length ?? 0) > 0 ? 'image' : 'text';
}
