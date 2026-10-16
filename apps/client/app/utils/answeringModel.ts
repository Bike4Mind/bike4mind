import type { PromptMeta } from '@bike4mind/common';

export interface AnsweringModelLabel {
  label: string;
  replaces?: string;
}

/**
 * The model name a reply should carry: the model that answered (`model.name`), plus the model it
 * replaced when a deprecated-model redirect swapped one in (`redirectedFrom`). Null when the turn
 * recorded no model.
 */
export function answeringModelLabel(
  promptMeta: Pick<PromptMeta, 'model' | 'redirectedFrom'> | undefined,
  displayName: (modelId: string) => string
): AnsweringModelLabel | null {
  const name = promptMeta?.model?.name;
  if (!name) return null;
  const from = promptMeta.redirectedFrom;
  return from ? { label: displayName(name), replaces: displayName(from) } : { label: displayName(name) };
}
