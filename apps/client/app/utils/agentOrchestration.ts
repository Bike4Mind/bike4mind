/**
 * Helpers for routing @mention messages to the agent execution Lambda vs. the
 * normal chat completion path.
 *
 * An IAgent qualifies for orchestration dispatch when ANY orchestration
 * field is set on the agent definition. This keeps the trigger UX backward
 * compatible: agents created before orchestration fields existed keep their
 * existing `@mention -> chat_completion` behavior.
 */

import { OrchestrationDefaultsSchema, type IAgent, type OrchestrationDefaults } from '@bike4mind/common';

export function hasOrchestrationFields(agent: IAgent): boolean {
  if (agent.maxIterations) {
    const { quick, medium, very_thorough } = agent.maxIterations;
    if (quick || medium || very_thorough) return true;
  }
  if (agent.allowedTools && agent.allowedTools.length > 0) return true;
  if (agent.deniedTools && agent.deniedTools.length > 0) return true;
  if (agent.defaultThoroughness) return true;
  return false;
}

/**
 * Pick the orchestration-enabled agent from a list of mentioned agents.
 * If multiple agents are mentioned and more than one is orchestration-enabled,
 * we choose the first; multi-agent orchestration is out of scope.
 */
export function pickOrchestrationAgent(agents: IAgent[]): IAgent | null {
  return agents.find(hasOrchestrationFields) ?? null;
}

/**
 * Synthetic orchestration profile: the shape returned by
 * `buildDefaultOrchestrationProfile` and used by callers that need to
 * dispatch the agent executor without a persisted `IAgent` - i.e. the
 * Agent-mode toggle and the dormant `@agent` literal trigger.
 *
 * Mirrors the orchestration subset of `IAgent` plus a stable synthetic id and
 * `isSynthetic: true` marker so downstream consumers (logging, billing
 * attribution) can distinguish synthetic dispatches from real-agent ones.
 *
 * NOT an `IAgent`: synthetic profiles have no personality / visual / identity
 * fields and are never persisted to the agents collection.
 */
export interface SyntheticOrchestrationProfile {
  /** Stable marker so logs/billing can attribute runs to the synthetic profile. */
  id: string;
  /** Human-readable label for UI surfaces (e.g. "Default agent"). */
  name: string;
  /** Model the profile dispatches against - caller-controlled, not seeded from admin settings. */
  preferredModel: string;
  /** Tool whitelist sourced from `orchestrationDefaults.allowedTools`. */
  allowedTools: string[];
  /** Tool denylist sourced from `orchestrationDefaults.deniedTools`. */
  deniedTools: string[];
  /** Per-thoroughness iteration ceiling. */
  maxIterations: { quick: number; medium: number; very_thorough: number };
  /** Thoroughness selected when the caller does not override. */
  defaultThoroughness: 'quick' | 'medium' | 'very_thorough';
  /** Fallback models tried in order if the primary fails. */
  fallbackModels: string[];
  /** Whether `coordinate_task` (DAG decomposition) is enabled. */
  dagEnabled: boolean;
  /** Discriminator vs `IAgent`. */
  isSynthetic: true;
}

/**
 * Build a synthetic orchestration profile from admin-configured defaults.
 *
 * Used by the Agent-mode toggle to dispatch `agent_execute` without a persisted
 * `IAgent`. The returned profile mirrors the orchestration subset of `IAgent`,
 * sourced from `adminSettings.orchestrationDefaults`, so admins control the
 * conservative default toolbelt org-wide.
 *
 * `dagEnabled === false` strips `coordinate_task` from `allowedTools` so the
 * synthetic profile can't decompose into subagents - the dispatched executor
 * still surfaces the tool only when present in `enabledTools`.
 */
export function buildDefaultOrchestrationProfile(
  adminSettings: OrchestrationDefaults | null | undefined,
  model: string
): SyntheticOrchestrationProfile {
  // When admin settings can't be loaded (e.g. `getSettingsValue` threw on a
  // network blip), fall back to the schema's own seed so degraded-mode runs
  // get the same conservative toolbelt admins see by default - rather than
  // an unusable empty allowedTools list. `OrchestrationDefaultsSchema.parse({})`
  // is the single source of truth for the seed values.
  const defaults: OrchestrationDefaults = adminSettings ?? OrchestrationDefaultsSchema.parse({});

  const allowedTools = defaults.dagEnabled
    ? defaults.allowedTools
    : defaults.allowedTools.filter(t => t !== 'coordinate_task');

  return {
    id: 'synthetic:default-orchestration',
    name: 'Default agent',
    preferredModel: model,
    allowedTools,
    deniedTools: defaults.deniedTools,
    maxIterations: defaults.maxIterations,
    defaultThoroughness: defaults.defaultThoroughness,
    fallbackModels: defaults.fallbackModels,
    dagEnabled: defaults.dagEnabled,
    isSynthetic: true,
  };
}
