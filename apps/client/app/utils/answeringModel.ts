import type { PromptMeta } from '@bike4mind/common';

export interface AnsweringModelLabel {
  label: string;
  replaces?: string;
}

/**
 * The model name a reply should carry: the model that answered, plus the model it replaced when a
 * deprecated-model redirect swapped one in. Null when the turn recorded no model.
 */
export function answeringModelLabel(
  promptMeta: Pick<PromptMeta, 'model'> | undefined,
  displayName: (modelId: string) => string
): AnsweringModelLabel | null {
  const model = promptMeta?.model;
  if (!model?.name) return null;
  if (!model.answeredBy || model.answeredBy === model.name) return { label: displayName(model.name) };
  return { label: displayName(model.answeredBy), replaces: displayName(model.name) };
}
