/**
 * Resolve the top-level orchestration profile for an agent_executor run.
 * The profile drives `enabledTools` and `maxIterations` defaults when
 * the caller hasn't pinned them explicitly.
 *
 * Two paths:
 *   - **Persisted agent**: `startPayload.agentId` set -> look up the IAgent and
 *     project its orchestration fields onto a `ResolvedOrchestrationProfile`.
 *     Used by the dormant `@agent` literal trigger.
 *   - **Synthetic**: `startPayload.agentId` absent -> build a default profile
 *     from admin `orchestrationDefaults`. Used by the upcoming Agent-mode
 *     toggle.
 *
 * Extracted into its own pure helper so the branching can be unit-tested
 * directly without dragging in Mongo/AWS/ReActAgent - matches the pattern
 * established by `agentExecutor.reActAgentConfig.ts` and
 * `agentExecutor.firstIterationQuery.ts`.
 */

import { buildAgentPersonaPrompt, type IAgent, type OrchestrationDefaults } from '@bike4mind/common';
import { buildDefaultOrchestrationProfile } from '@client/app/utils/agentOrchestration';

/**
 * Subset of the orchestration fields the executor actually consumes when
 * deciding the top-level tool whitelist and iteration ceiling. Intentionally
 * narrower than `IAgent` so callers don't conflate it with a full persisted
 * agent.
 */
export interface ResolvedOrchestrationProfile {
  /** Stable id for logs / billing attribution. Persisted IAgent id, or `synthetic:*`. */
  id: string;
  /** Human-readable label for logs. */
  name: string;
  /** Tool whitelist sourced from agent OR admin defaults. */
  allowedTools: string[];
  /** Tool denylist sourced from agent OR admin defaults. */
  deniedTools: string[];
  /** Per-thoroughness iteration ceiling. */
  maxIterations: { quick: number; medium: number; very_thorough: number };
  /** Thoroughness selected when the caller does not override. */
  defaultThoroughness: 'quick' | 'medium' | 'very_thorough';
  /** Whether this profile was synthesized from admin defaults (vs sourced from a persisted IAgent). */
  isSynthetic: boolean;
  /**
   * Persona system prompt for the agent (#agent-mode-persona). Sourced from a
   * persisted IAgent's `systemPrompt` / `personality` via `buildAgentPersonaPrompt`.
   * `undefined` for synthetic (agentless) profiles, which have no persona.
   * The executor prepends this to the ReActAgent prompt so an Agent-mode run
   * speaks in the agent's configured personality (the path previously injected none).
   */
  systemPrompt?: string;
}

export interface ResolveTopLevelProfileArgs {
  /** `agentId` from the start payload - undefined means agentless. */
  agentId: string | undefined;
  /** Loader that returns the persisted agent doc, or null if not found / unauthorized / deleted. */
  loadAgent: (id: string) => Promise<IAgent | null>;
  /** Admin orchestration defaults - typically the parsed `orchestrationDefaults` setting. */
  adminDefaults: OrchestrationDefaults | null | undefined;
  /** Caller-supplied model - flows through to the synthetic profile. */
  model: string;
}

/**
 * Default iteration ceiling matches `DEFAULT_MAX_ITERATIONS` in agentExecutor.ts.
 * Re-declared here (rather than imported) to keep this helper free of cross-file
 * coupling with the executor's runtime constants.
 */
const DEFAULT_MAX_ITERATIONS = { quick: 5, medium: 15, very_thorough: 30 } as const;
const DEFAULT_THOROUGHNESS = 'medium' as const;

export async function resolveTopLevelProfile(args: ResolveTopLevelProfileArgs): Promise<ResolvedOrchestrationProfile> {
  if (args.agentId) {
    const agent = await args.loadAgent(args.agentId);
    if (agent) {
      // Layer the persisted agent's orchestration fields over admin defaults
      // so legacy IAgent records that lack orchestration fields
      // still land on the conservative defaults instead of an empty toolbelt.
      // Per-field fallback (not whole-object) lets a partially-configured
      // agent override only the dimensions it cares about.
      const allowedTools = agent.allowedTools?.length ? agent.allowedTools : (args.adminDefaults?.allowedTools ?? []);
      const deniedTools = agent.deniedTools?.length ? agent.deniedTools : (args.adminDefaults?.deniedTools ?? []);
      // `dagEnabled: false` is the org-wide kill switch for `coordinate_task`
      // - applies to the persisted-agent path too, otherwise an admin couldn't
      // genuinely shut off DAG decomposition without editing every agent.
      const dagEnabled = args.adminDefaults?.dagEnabled ?? true;
      const filteredAllowed = dagEnabled ? allowedTools : allowedTools.filter(t => t !== 'coordinate_task');
      return {
        id: agent.id,
        name: agent.name,
        allowedTools: filteredAllowed,
        deniedTools,
        maxIterations: agent.maxIterations ?? args.adminDefaults?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        defaultThoroughness:
          agent.defaultThoroughness ?? args.adminDefaults?.defaultThoroughness ?? DEFAULT_THOROUGHNESS,
        isSynthetic: false,
        // Persona for the ReActAgent - generated `systemPrompt` if present, else
        // composed from personality/identity fields. Same builder the classic
        // chat path uses, so the agent behaves identically in both paths.
        systemPrompt: buildAgentPersonaPrompt(agent),
      };
    }
    // Missing / unauthorized / soft-deleted agent - fall through to synthetic
    // so the run still proceeds with safe defaults rather than failing the
    // dispatch hard.
  }

  const synthetic = buildDefaultOrchestrationProfile(args.adminDefaults, args.model);
  return {
    id: synthetic.id,
    name: synthetic.name,
    allowedTools: synthetic.allowedTools,
    deniedTools: synthetic.deniedTools,
    maxIterations: synthetic.maxIterations,
    defaultThoroughness: synthetic.defaultThoroughness,
    isSynthetic: true,
  };
}

/**
 * Pick the effective iteration ceiling - payload override beats profile default.
 * The executor already enforces a hard ceiling of 100 via the Zod schema; this
 * helper only chooses the *default* when the payload omits it.
 */
export function pickEffectiveMaxIterations(
  payloadMaxIterations: number | undefined,
  profile: ResolvedOrchestrationProfile
): number {
  if (payloadMaxIterations !== undefined) return payloadMaxIterations;
  return profile.maxIterations[profile.defaultThoroughness];
}

/**
 * Pick the effective tool whitelist - payload override beats profile default,
 * but the profile's `deniedTools` ALWAYS wins as a final subtraction so an
 * admin denylist can't be bypassed by shipping `enabledTools` in the payload.
 *
 * An EMPTY payload array is treated as "use profile" rather than "explicitly
 * no tools" because the chat dispatch path can ship `[]` when no per-message
 * override is set; an explicit empty set is rare and indistinguishable here.
 */
export function pickEffectiveEnabledTools(
  payloadEnabledTools: string[] | undefined,
  profile: ResolvedOrchestrationProfile
): string[] {
  const chosen = payloadEnabledTools && payloadEnabledTools.length > 0 ? payloadEnabledTools : profile.allowedTools;
  if (profile.deniedTools.length === 0) return chosen;
  const denied = new Set(profile.deniedTools);
  return chosen.filter(t => !denied.has(t));
}
