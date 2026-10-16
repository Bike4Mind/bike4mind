import type { PromptMeta } from '@bike4mind/common';

export interface AnsweringModelLabel {
  label: string;
  replaces?: string;
}

/**
 * The model name a reply should carry: the model that answered (`model.name`), plus the model it
 * replaced when a deprecated-model redirect swapped one in (`redirectedFrom`). An error reply names
 * the model that failed without claiming it replaced anything. Null when the turn recorded no model.
 */
export function answeringModelLabel(
  promptMeta: Pick<PromptMeta, 'model' | 'redirectedFrom'> | undefined,
  displayName: (modelId: string) => string,
  isError = false
): AnsweringModelLabel | null {
  const name = promptMeta?.model?.name;
  if (!name) return null;
  const from = isError ? undefined : promptMeta.redirectedFrom;
  return from ? { label: displayName(name), replaces: displayName(from) } : { label: displayName(name) };
}

/**
 * The model id a turn was requested for: the redirect source when a deprecated-model swap happened,
 * otherwise the model that answered. Undefined when the turn recorded no model.
 */
export function requestedModelId(
  promptMeta: Pick<PromptMeta, 'model' | 'redirectedFrom'> | undefined
): string | undefined {
  return promptMeta?.redirectedFrom ?? promptMeta?.model?.name;
}
