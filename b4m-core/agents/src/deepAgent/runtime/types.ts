import type {
  ActionTaken,
  Charter,
  CharterDiff,
  DriveVector,
  Episode,
  Handoff,
  Observation,
  PolicyDecision,
  SemanticMemoryEntry,
  Subgoal,
} from '../schemas';

/**
 * Deep Agent wake-cycle runtime - infra-free SDK core.
 *
 * The orchestrator (`runWakeCycle`) depends on two ports, both injected so the
 * loop logic is unit-testable with fakes (no Mongo, no LLM) and host apps can
 * supply their own persistence + cognition:
 *   - `DeepAgentStore` - persistence (implemented by a host adapter, e.g. Mongo)
 *   - `WakeSteps`      - the cognitive steps (implemented by an LLM-backed adapter)
 *
 * Keeping these ports + the loop in `@bike4mind/agents` lets the package stay a
 * pure, Mongo-free SDK: the host's database/LLM wiring lives entirely behind the
 * port implementations.
 */

/**
 * Persistence port. Trafficks exclusively in the Zod domain types (ISO-string
 * timestamps); the storage-specific concerns (Date types, internal ids) live
 * entirely in the implementation. Reads are Zod-validated at the boundary.
 */
export interface DeepAgentStore {
  loadCharter(agentId: string): Promise<Charter | null>;
  saveCharter(charter: Charter): Promise<Charter>;
  loadHandoff(agentId: string): Promise<Handoff | null>;
  saveHandoff(handoff: Handoff): Promise<Handoff>;
  appendEpisode(episode: Episode): Promise<Episode>;
  recentEpisodes(agentId: string, limit?: number): Promise<Episode[]>;
}

// ── Step contexts ──────────────────────────────────────────────────

export interface OrientContext {
  charter: Charter;
  handoff: Handoff | null;
  recentEpisodes: Episode[];
  /** Drives AFTER time-decay, as the policy step should see them. */
  drives: DriveVector;
}

export interface ActContext {
  charter: Charter;
  policy: PolicyDecision;
  drives: DriveVector;
}

export interface ActResult {
  actionsTaken: ActionTaken[];
  observations: Observation[];
  tokensSpent: number;
  costUsd: number;
}

export interface ReflectContext {
  charter: Charter;
  policy: PolicyDecision;
  act: ActResult;
  drives: DriveVector;
  /** The wake's clock (ISO-8601) - timestamp fallbacks use this, not wall time. */
  nowIso?: string;
}

/**
 * Output of the reflect step. The cognitive layer supplies the semantic
 * content; the orchestrator owns charter mutation (versioning, groom trigger).
 * `charterDiff` is the narrow audit record stored on the Episode;
 * `addedSemanticMemory` / `removedSemanticMemoryIds` / `subgoalUpdates` are the
 * concrete mutations the orchestrator applies to the Charter.
 */
export interface ReflectResult {
  /** Episode.reflection - what happened / what was learned. */
  reflection: string;
  /** Handoff.lastActionSummary - one paragraph for the next orient prompt. */
  summary: string;
  /** Handoff.nextIntendedAction. */
  nextIntendedAction: string;
  /** Optional hint for the scheduler. */
  nextWakeIntervalMs?: number;
  /** Episode.scopeLocks - what was explicitly NOT done this wake. */
  scopeLocks: string[];
  /** Drives at end of wake (after action satisfaction). */
  drivesAfter: DriveVector;
  /** Narrow change record stored on the Episode. */
  charterDiff: CharterDiff;
  /** Concrete semantic-memory entries to add to the Charter. */
  addedSemanticMemory: SemanticMemoryEntry[];
  /** Semantic-memory entry ids to drop from the Charter. */
  removedSemanticMemoryIds: string[];
  /** Subgoals to upsert into the Charter (matched by id). */
  subgoalUpdates: Subgoal[];
  /** Replacement blocker list for the Charter + Handoff. */
  openBlockers: string[];
}

export interface GroomContext {
  /** The post-mutation charter that is over budget. */
  charter: Charter;
  recentEpisodes: Episode[];
  /** The wake's clock (ISO-8601) - timestamp fallbacks use this, not wall time. */
  nowIso?: string;
}

/**
 * The cognitive steps of a wake cycle. The LLM-backed adapter implements these;
 * tests supply deterministic fakes.
 */
export interface WakeSteps {
  orient(ctx: OrientContext): Promise<PolicyDecision>;
  act(ctx: ActContext): Promise<ActResult>;
  reflect(ctx: ReflectContext): Promise<ReflectResult>;
  /** Compact a charter back under its size budget. Returns the groomed charter. */
  groom(ctx: GroomContext): Promise<Charter>;
}

export interface WakeOutcome {
  episode: Episode;
  charter: Charter;
  handoff: Handoff;
  /** True if the charter exceeded budget this wake and the groom step ran. */
  groomed: boolean;
}
