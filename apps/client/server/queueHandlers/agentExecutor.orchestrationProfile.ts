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
   * Whether `allowedTools` IS the run's toolbelt rather than a default the payload may replace.
   *
   * A surface that authors its own profile is picking the toolset deliberately -- the loop only
   * works if every tool in the walk is present -- and the client already tells the user as much
   * ("your tool selection was replaced by the agent toolset") when the router upgrades a chat
   * send. Left false for admin-default and persisted-agent profiles, where the caller's payload
   * (a briefcase override, a quest node's scoped toolset) legitimately takes precedence.
   */
  toolsetIsExclusive?: boolean;
  /**
   * Persona system prompt for the agent (#agent-mode-persona). Sourced from a
   * persisted IAgent's `systemPrompt` / `personality` via `buildAgentPersonaPrompt`.
   * `undefined` for synthetic (agentless) profiles, which have no persona.
   * The executor prepends this to the ReActAgent prompt so an Agent-mode run
   * speaks in the agent's configured personality (the path previously injected none).
   */
  systemPrompt?: string;
  /**
   * Per-profile confidence-gate threshold. The executor pauses an iteration for human
   * review when its confidence falls below this. Omitted => the executor's global default
   * (CONFIDENCE_GATE_THRESHOLD). Set to 0 to effectively disable the gate for a profile
   * whose tools are sandboxed and whose loop is meant to run unattended (e.g. the
   * optimizer): a single recoverable tool error shouldn't halt an autonomous run for a
   * human, and maxIterations remains the runaway backstop.
   */
  confidenceGateThreshold?: number;
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
 * Pick the effective tool whitelist. Three payload dispositions, in precedence order:
 *
 * 1. `toolsetIsExclusive` profile -> the profile's toolset IS the toolbelt and the payload is
 *    ignored entirely. An agent whose toolset is declared exclusive means it.
 * 2. A PINNED non-empty payload REPLACES the profile default. The briefcase-override contract
 *    (`resolveDispatchTools` on the client) and a quest node's scoped toolset both depend on a
 *    deliberate selection surviving whatever profile the run resolves.
 * 3. An AMBIENT non-empty payload (`payloadIsAmbient`) is UNIONED onto the profile default
 *    instead. That is the agentless chat dispatch: the user's Smart Tools are picks they made
 *    for chat, not a statement about the agent's toolbelt, so replacing would strip the org's
 *    agent-mode tools and sending nothing would strip the user's picks. Unioning here - rather
 *    than on the client, which would have to derive the org toolbelt from admin config and put
 *    that derived copy on the wire - keeps the decision next to the profile it unions against.
 *
 * The union is gated on `isSynthetic`: a persisted agent's `allowedTools` is a deliberate
 * curation, so ambient chat picks must not widen it. Agentless dispatches always land on a
 * synthetic profile (`resolveTopLevelProfile` only takes the persisted path when `agentId` is
 * set), so the gate costs nothing and bounds the blast radius if a caller ever sets both.
 *
 * The profile's `deniedTools` ALWAYS wins as a final subtraction, so an admin denylist can't be
 * bypassed by shipping `enabledTools` in the payload - ambient or pinned. (For the two
 * delegation tools that subtraction is advisory only - they are injected as objects, never
 * registered by name; their effective enforcement is the dependency gate in agentExecutor via
 * `delegationOffer`.)
 *
 * NOTE: widening the toolbelt is not widening permissions. A side-effecting tool the union adds
 * still faces the permission gate, whose approval list (`AgentExecution.approvedTools`) is built
 * in `startAgentExecution` from the RAW payload and never from this result. That is also why a
 * headless caller, whose explicit `enabledTools` IS its approval, must never send the ambient
 * flag - the public REST contract deliberately has no such field.
 *
 * An EMPTY payload array is treated as "use profile" rather than "explicitly
 * no tools" because the chat dispatch path can ship `[]` when no per-message
 * override is set; an explicit empty set is rare and indistinguishable here.
 */
export function pickEffectiveEnabledTools(
  payloadEnabledTools: string[] | undefined,
  profile: ResolvedOrchestrationProfile,
  payloadIsAmbient?: boolean
): string[] {
  const chosen = chooseToolbelt(payloadEnabledTools, profile, payloadIsAmbient);
  if (profile.deniedTools.length === 0) return chosen;
  const denied = new Set(profile.deniedTools);
  return chosen.filter(t => !denied.has(t));
}

function chooseToolbelt(
  payloadEnabledTools: string[] | undefined,
  profile: ResolvedOrchestrationProfile,
  payloadIsAmbient: boolean | undefined
): string[] {
  if (!payloadEnabledTools?.length || profile.toolsetIsExclusive) return profile.allowedTools;
  if (payloadIsAmbient && profile.isSynthetic) {
    return [...new Set([...payloadEnabledTools, ...profile.allowedTools])];
  }
  return payloadEnabledTools;
}
