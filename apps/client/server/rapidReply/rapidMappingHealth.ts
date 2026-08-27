import type { ModelInfo } from '@bike4mind/common';
import { resolveSuccessorChain } from '@bike4mind/llm-adapters';

/**
 * Which of these mappings' rapid model ids cannot currently run.
 *
 * A mapping row stores a model *id*, and the id ages: a catalog lifecycle row sunsets it, an
 * operator disables it, and the row keeps pointing at the same id. The endpoint degrades to a
 * fallback rather than failing (see `resolveRapidModel`), which is right for the user but also
 * makes a rotted row invisible outside request logs - so the admin tab has to name them.
 *
 * Resolved through `resolveSuccessorChain`, NOT `resolveDeprecatedModelId`: an id whose
 * successor is live is healthy, and the latter emits the alarmable `[model-sunset]` metric,
 * which must count real traffic only and never an admin page view.
 *
 * @param models the caller's `getAvailableModels` result. Pass the unrestricted list (no
 *   listing options), so this observes what the rapid-reply endpoint observes rather than the
 *   picker's narrower, private-model-excluding view.
 */
export function findRottedRapidModelIds(mappings: { rapidModelId: string }[], models: ModelInfo[]): string[] {
  // A disabled model is listed so the picker can grey it out, but it can never run, so for
  // this purpose it is just as rotted as an id the deprecation filter removed outright.
  const runnable = new Set<string>(models.filter(m => !m.disabled).map(m => m.id));

  return [...new Set(mappings.map(m => m.rapidModelId).filter(id => !runnable.has(resolveSuccessorChain(id))))];
}
