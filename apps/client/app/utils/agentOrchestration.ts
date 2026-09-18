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

/**
 * The agent-mode default toolbelt in server tool vocabulary: the org's
 * `orchestrationDefaults.allowedTools` minus its `deniedTools`, with
 * `coordinate_task` dropped when DAG decomposition is off (mirroring
 * `buildDefaultOrchestrationProfile` above).
 *
 * Returns `null` for "we do not know the org's policy" - an absent or malformed
 * stored value. Deliberately not the schema seed: `resolveDispatchTools` unions
 * this onto the user's Smart Tools and the server does NOT intersect
 * (`pickEffectiveEnabledTools` REPLACES `profile.allowedTools` with a non-empty
 * payload; only `deniedTools` is subtracted afterwards), so a guessed base would
 * hand back tools an admin had narrowed away org-wide. `null` makes the caller
 * send no payload, leaving the server to resolve the real profile.
 *
 * Callers must ALSO treat "the authed settings fetch has not landed" as `null`
 * rather than passing whatever `getSettingObject` returns: `orchestrationDefaults`
 * is not `publicSafe`, but `AdminSettingsContext.mergeIntoDefaults` seeds every
 * key with its compiled-in default, so a defaulted key looks exactly like a real
 * one here. `useSendMessage` gates on `authedSettingsLoaded` for that reason.
 *
 * An empty set is a DIFFERENT, readable answer: an admin who set
 * `allowedTools: []` (or denied everything) turned the agent toolbelt off
 * org-wide. Distinguishing the two is the point of the nullable return.
 *
 * A tool missing from a non-empty set is a tool the agent silently loses, so
 * this must stay in sync with `OrchestrationDefaultsSchema`.
 */
export function agentModeDefaultToolNames(adminDefaults: unknown): ReadonlySet<string> | null {
  if (adminDefaults === null || adminDefaults === undefined) return null;
  const parsed = OrchestrationDefaultsSchema.safeParse(adminDefaults);
  if (!parsed.success) {
    // A malformed stored value degrades org-wide and permanently, with no UI
    // signal, so leave a breadcrumb rather than failing mute.
    console.warn('[agentMode] orchestrationDefaults failed validation; agentless dispatch will defer to the server', {
      issues: parsed.error.issues,
    });
    return null;
  }
  const defaults = parsed.data;
  const denied = new Set(defaults.deniedTools);
  const allowed = defaults.dagEnabled
    ? defaults.allowedTools
    : defaults.allowedTools.filter(t => t !== 'coordinate_task');
  return new Set(allowed.filter(tool => !denied.has(tool)));
}
