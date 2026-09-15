import { z } from 'zod';
import { DriveVectorSchema, type DriveVector } from './drives';
import { EvidenceTierSchema, type EvidenceTier } from './evidence';

/**
 * Default charter size budget in bytes. 8KB honors the Ember scarcity insight:
 * a hard cap forces the agent to *curate* rather than accumulate, and curation
 * is the mechanism by which identity and taste emerge.
 *
 * Tunable per agent; production research agents may need more, but the cap
 * itself is load-bearing.
 */
export const DEFAULT_CHARTER_SIZE_BUDGET_BYTES = 8 * 1024;

/**
 * Identity is the slow-changing core of the charter. Once set, these fields
 * rarely change - the agent's name and instantiation moment are stable
 * anchors across the inevitable identity discontinuities (deploys, model
 * swaps, context overflows).
 */
export const CharterIdentitySchema = z.object({
  /** Stable agent id (the load-bearing key across all storage). */
  agentId: z.string().min(1),
  /**
   * The user who owns this agent. Tool execution runs as this user - their
   * storage, billing, and permissions scope the agent's actions. Long-horizon
   * agents are headless but always answer to an owner.
   */
  ownerUserId: z.string().min(1),
  /**
   * MISSION LINKAGE: when set, this charter is a Mission of an existing B4M
   * Agent (the AgentModel id). The mission inherits the agent's persona
   * (system prompt) and tool policy at act time; `agentId` above remains the
   * mission's own unique key, so one B4M agent can run many missions.
   * Absent = a standalone deep agent (the original mode).
   */
  linkedAgentId: z.string().min(1).optional(),
  /** Human-readable name. Public; appears in logs and dashboards. */
  name: z.string().min(1),
  /** Role / archetype, e.g. "paper-repro", "game-designer", "researcher". */
  role: z.string().min(1),
  /** ISO-8601 timestamp of first wake. */
  instantiatedAt: z.string().datetime(),
  /** Charter schema version, for migrations. */
  schemaVersion: z.literal(1),
});

export type CharterIdentity = {
  agentId: string;
  ownerUserId: string;
  linkedAgentId?: string;
  name: string;
  role: string;
  instantiatedAt: string;
  schemaVersion: 1;
};

/**
 * The goal is what the agent is pursuing. `successCriteria` should be
 * concrete enough that the reflect step can decide whether progress was made.
 * `deadlineKind` is intentionally a soft category rather than a wall-clock
 * date - long-horizon research has no real deadline; game prototypes do.
 */
export const CharterGoalSchema = z
  .object({
    description: z.string().min(1),
    successCriteria: z.array(z.string()).default([]),
    deadlineKind: z.enum(['none', 'soft', 'hard']).default('none'),
    /** ISO-8601; only meaningful (and only allowed) when deadlineKind !== 'none'. */
    deadlineAt: z.string().datetime().optional(),
  })
  .refine(goal => goal.deadlineKind !== 'none' || goal.deadlineAt === undefined, {
    message: "deadlineAt requires deadlineKind to be 'soft' or 'hard'",
    path: ['deadlineAt'],
  });

export type CharterGoal = {
  description: string;
  successCriteria: string[];
  deadlineKind: 'none' | 'soft' | 'hard';
  deadlineAt?: string;
};

export const SubgoalStatusSchema = z.enum(['planned', 'active', 'blocked', 'completed', 'abandoned']);

export type SubgoalStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'abandoned';

export const SubgoalSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  status: SubgoalStatusSchema.default('planned'),
  /** Higher = more important. Used by the policy step to rank. */
  priority: z.number().int().min(0).max(100).default(50),
  /** Tier required for this subgoal to be considered "done". */
  targetTier: EvidenceTierSchema.default('engineering-scaled'),
  /** IDs of subgoals that must complete before this one is unblocked. */
  dependsOn: z.array(z.string()).default([]),
});

export type Subgoal = {
  id: string;
  description: string;
  status: SubgoalStatus;
  priority: number;
  targetTier: EvidenceTier;
  dependsOn: string[];
};

/**
 * A semantic memory entry is a single distilled fact the agent has chosen
 * to preserve across wake cycles. Provenance-typed via `evidenceTier`.
 *
 * `sourceEpisodeIds` lets the agent (and humans) trace any claim back to
 * the wake cycles in which it was formed - the audit trail that makes
 * adversarial review tractable.
 */
export const SemanticMemoryEntrySchema = z.object({
  id: z.string().min(1),
  fact: z.string().min(1),
  evidenceTier: EvidenceTierSchema,
  /** Subjective confidence in [0, 1]. Self-reported by the agent. */
  confidence: z.number().min(0).max(1).default(0.5),
  sourceEpisodeIds: z.array(z.string()).default([]),
  /** ISO-8601 when this entry was last reaffirmed during grooming. */
  lastAffirmedAt: z.string().datetime(),
});

export type SemanticMemoryEntry = {
  id: string;
  fact: string;
  evidenceTier: EvidenceTier;
  confidence: number;
  sourceEpisodeIds: string[];
  lastAffirmedAt: string;
};

/**
 * The Charter is the slow-changing identity + goal + groomed-memory document
 * the agent reads on every wake and grooms when it gets too large.
 *
 * Pairs with the Handoff (handoff.ts) - fast-changing per-wake document
 * holding "what I was just doing and what I'll do next". The split is lifted
 * directly from q-paper-neutron-scattering's reproduction_charter.md +
 * handoff.md pattern.
 */
export const CharterSchema = z.object({
  identity: CharterIdentitySchema,
  goal: CharterGoalSchema,
  /** Current drive vector (decayed at wake time before policy step). */
  drives: DriveVectorSchema,
  subgoals: z.array(SubgoalSchema).default([]),
  semanticMemory: z.array(SemanticMemoryEntrySchema).default([]),
  /**
   * The tier the agent is currently operating at. Tier-gated progression
   * (Tier 0 charter -> Tier N envelope) is inherited from q-paper's tier
   * system. Drives and budgets behave differently per tier.
   */
  currentTier: EvidenceTierSchema.default('engineering-proxy'),
  /** Open questions the agent wants to resolve. Free-form. */
  openQuestions: z.array(z.string()).default([]),
  /** Active blockers (mirrored from the workflow blocker system if used). */
  blockers: z.array(z.string()).default([]),
  /**
   * The B4M session acting as this charter's mission log - wake summaries and
   * deliverables land there as chat history. Created lazily on first bridge.
   */
  sessionId: z.string().min(1).optional(),
  /** Size budget in bytes. Grooming is triggered when exceeded. */
  sizeBudgetBytes: z.number().int().positive().default(DEFAULT_CHARTER_SIZE_BUDGET_BYTES),
  /** Monotonic version counter, bumped on every successful groom/update. */
  version: z.number().int().nonnegative().default(0),
  /** ISO-8601 of last groom (compaction). */
  groomedAt: z.string().datetime().optional(),
  /** ISO-8601 of last update (any field). */
  updatedAt: z.string().datetime(),
});

export type Charter = {
  identity: CharterIdentity;
  goal: CharterGoal;
  drives: DriveVector;
  subgoals: Subgoal[];
  semanticMemory: SemanticMemoryEntry[];
  currentTier: EvidenceTier;
  openQuestions: string[];
  blockers: string[];
  sessionId?: string;
  sizeBudgetBytes: number;
  version: number;
  groomedAt?: string;
  updatedAt: string;
};

/**
 * Measure the on-disk size of a charter when serialized as JSON. Used by the
 * grooming trigger and by tests asserting the size budget is honored.
 */
export function measureCharterSizeBytes(charter: Charter): number {
  return Buffer.byteLength(JSON.stringify(charter), 'utf8');
}

/**
 * True iff the charter's serialized size exceeds its budget. Caller fires
 * the groom prompt when this returns true.
 */
export function isCharterOverBudget(charter: Charter): boolean {
  return measureCharterSizeBytes(charter) > charter.sizeBudgetBytes;
}
