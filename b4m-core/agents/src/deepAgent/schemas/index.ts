/**
 * Deep Agent schemas - barrel export.
 *
 * Architecture: docs/concepts/deep-agent-framework.md
 *
 * Quest 1 of the Deep Agent framework. These schemas are the
 * load-bearing data model; everything else (heartbeat, policy,
 * reflect, groom, scheduler) hangs off them.
 */

// ── Charter (slow-changing identity document) ──────────────────────
export {
  CharterGoalSchema,
  CharterIdentitySchema,
  CharterSchema,
  DEFAULT_CHARTER_SIZE_BUDGET_BYTES,
  SemanticMemoryEntrySchema,
  SubgoalSchema,
  SubgoalStatusSchema,
  isCharterOverBudget,
  measureCharterSizeBytes,
  type Charter,
  type CharterGoal,
  type CharterIdentity,
  type SemanticMemoryEntry,
  type Subgoal,
  type SubgoalStatus,
} from './charter';

// ── Handoff (fast-changing per-wake document) ──────────────────────
export { HandoffSchema, measureHandoffSizeBytes, type Handoff } from './handoff';

// ── Episode (per-wake-cycle structured record) ─────────────────────
export {
  ActionTakenSchema,
  CharterDiffSchema,
  EpisodeSchema,
  ObservationSchema,
  PolicyDecisionSchema,
  type ActionTaken,
  type CharterDiff,
  type Episode,
  type Observation,
  type PolicyDecision,
} from './episode';

// ── Drives (motivation as first-class object) ──────────────────────
export {
  DEFAULT_DRIVES,
  DEFAULT_HALF_LIVES_MS,
  DRIVE_KEYS,
  DriveVectorSchema,
  applyDriveDelta,
  decayDrives,
  summarizeDrives,
  type DriveKey,
  type DriveVector,
} from './drives';

// ── Evidence tiers (rigor as an axis) ──────────────────────────────
export {
  EVIDENCE_TIER_ORDER,
  EvidenceTierSchema,
  evidenceTierAtLeast,
  evidenceTierRank,
  type EvidenceTier,
} from './evidence';

// ── Review (adversarial verdict over an episode) ───────────────────
export { ReviewVerdictSchema, type ReviewVerdict } from './review';
