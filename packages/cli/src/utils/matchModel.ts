import type { ModelInfo } from '@bike4mind/common';

export type ModelMatch =
  { kind: 'none' } | { kind: 'single'; model: ModelInfo } | { kind: 'multiple'; models: ModelInfo[] };

/**
 * Resolve a free-text `/model` argument against the available models.
 *
 * An exact (case-insensitive) id or name match always wins and resolves to a
 * single model, even when it is also a substring of other models. Otherwise
 * the query is treated as a case-insensitive substring of the id or name; the
 * caller decides how to present `none`/`single`/`multiple`.
 */
export function matchModel(models: ModelInfo[], query: string): ModelMatch {
  const q = query.trim().toLowerCase();
  if (q === '') return { kind: 'none' };

  const exact = models.find(m => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  if (exact) return { kind: 'single', model: exact };

  const matches = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'single', model: matches[0] };
  return { kind: 'multiple', models: matches };
}
