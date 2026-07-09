import type { InteractionMode } from '../bootstrap/types.js';

/**
 * Permissiveness rank of each interaction mode: a higher rank grants the agent
 * more autonomy (fewer prompts, more mutation). Used to clamp a spawned agent's
 * mode so a child can never run more permissively than its parent.
 *
 * Ordering (least -> most permissive):
 *   plan        - read-only; mutating tools are blocked entirely.
 *   normal      - mutating tools require an explicit permission prompt.
 *   auto-accept - permission prompts are skipped.
 */
export const INTERACTION_MODE_RANK: Record<InteractionMode, number> = {
  plan: 0,
  normal: 1,
  'auto-accept': 2,
};

/**
 * Clamp a requested interaction mode to a ceiling, returning whichever is less
 * permissive. Guarantees the result's rank is <= both inputs, so a spawned agent
 * can never exceed its parent's authority (e.g. a `normal` parent can never yield
 * an `auto-accept` child), while a more restrictive request is still honored.
 */
export function clampInteractionMode(requested: InteractionMode, ceiling: InteractionMode): InteractionMode {
  return INTERACTION_MODE_RANK[requested] <= INTERACTION_MODE_RANK[ceiling] ? requested : ceiling;
}
