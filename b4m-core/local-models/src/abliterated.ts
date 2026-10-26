import type { HubModelSummary } from './huggingface';

const WHOLE_WORD_MARKERS = /(^|[^a-z])(uncensored|decensored|heretic)([^a-z]|$)/;

/** Builds with refusal training removed, by explicit markers in the repo id, its tags or its base models. */
export function isAbliteratedModel(
  model: Pick<HubModelSummary, 'id'> & Partial<Pick<HubModelSummary, 'tags' | 'baseModels'>>
): boolean {
  return [model.id, ...(model.tags ?? []), ...(model.baseModels ?? [])].some(name => {
    const lower = name.toLowerCase();
    return lower.includes('abliterat') || WHOLE_WORD_MARKERS.test(lower);
  });
}
