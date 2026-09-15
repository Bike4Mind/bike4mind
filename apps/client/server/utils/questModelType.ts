export type QuestModelType = 'text' | 'image' | 'video';

/**
 * Admin-metrics view of a quest's modality.
 *
 * `promptMeta.model.type` is authoritative whenever the writer recorded it, so attached images are
 * a fallback for rows that predate it rather than an override - treating images as an override
 * would report a video turn as an image, and the chars-per-second chart gates on `=== 'text'`.
 *
 * Shared by the analytics and model-metrics projections so the two cannot drift apart again.
 */
export function resolveQuestModelType(quest: {
  promptMeta?: { model?: { type?: QuestModelType } | null } | null;
  images?: string[] | null;
}): QuestModelType {
  return quest.promptMeta?.model?.type ?? ((quest.images?.length ?? 0) > 0 ? 'image' : 'text');
}
