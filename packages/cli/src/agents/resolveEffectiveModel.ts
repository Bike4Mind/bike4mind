/**
 * Inputs for resolving the model a spawned agent runs on.
 */
export interface ModelResolutionInputs {
  /** Explicit per-spawn model request (e.g. a skill or dynamic-agent override). */
  requestedModel?: string;
  /** The agent definition's model (may be a placeholder default). */
  agentModel: string;
  /** Whether agentModel was explicitly declared (vs. a placeholder default). */
  agentModelResolved: boolean;
  /** The parent agent's effective model - the inherit target for a nested spawn. */
  parentModel?: string;
  /** The main session's default model. */
  sessionDefaultModel?: string;
}

/**
 * Resolve a spawned agent's model through an explicit precedence, so a child can
 * never *silently* pick a different (e.g. stronger) model than it was granted:
 *
 *   1. an explicit per-spawn request                         (deliberate),
 *   2. the agent definition's explicitly-declared model      (deliberate),
 *   3. inherit the parent's model, else the main session model (the explicit
 *      inherit path - the child follows what it was granted, not a hardcoded default),
 *   4. the agent definition's placeholder default             (last resort).
 *
 * Only the default path (3) is implicit, and it inherits rather than inventing a
 * model. Deliberate choices (1, 2) are always honored.
 */
export function resolveEffectiveModel(inputs: ModelResolutionInputs): string {
  const { requestedModel, agentModel, agentModelResolved, parentModel, sessionDefaultModel } = inputs;
  if (requestedModel) return requestedModel;
  if (agentModelResolved) return agentModel;
  return parentModel ?? sessionDefaultModel ?? agentModel;
}
