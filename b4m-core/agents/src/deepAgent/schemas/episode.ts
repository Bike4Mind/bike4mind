import { z } from 'zod';
import { DriveVectorSchema, type DriveVector } from './drives';
import { EvidenceTierSchema, type EvidenceTier } from './evidence';

/**
 * Deep Agent Episode - the per-wake-cycle structured record.
 *
 * One Episode is written per wake cycle. Episodes are append-only and
 * unbounded; they are the agent's raw experience log. Periodically the
 * grooming process consolidates episodes into Charter semantic memory,
 * compressing many concrete experiences into fewer reusable facts.
 *
 * Key q-paper-neutron-scattering pattern: every Episode carries explicit
 * `scopeLocks` - what the agent *did NOT do* in this wake. This is the
 * agentic equivalent of Postel's principle (be conservative in what you
 * claim to have done) and is what makes adversarial review tractable.
 */

/**
 * The policy decision made by the orient step at the start of a wake.
 *
 * The policy step is a cheap LLM call: given charter + recent episodes
 * + current drives, what action class maximizes expected drive
 * satisfaction subject to the goal and tier? Its output is captured
 * here for later analysis of decision quality.
 */
export const PolicyDecisionSchema = z.object({
  /**
   * Named action class (matches a key in the agent's toolbelt profile).
   * Examples: "read_paper", "run_experiment", "ideate_hypothesis",
   * "request_review", "consolidate_memory".
   */
  actionKind: z.string().min(1),

  /** Natural-language justification for the choice. */
  rationale: z.string().min(1),

  /**
   * The drive deltas the policy expects this action to produce.
   * Compared against actual deltas at reflect time to calibrate
   * future policy decisions.
   */
  expectedDriveDelta: z.record(z.string(), z.number()).default({}),
});

export type PolicyDecision = {
  actionKind: string;
  rationale: string;
  expectedDriveDelta: Record<string, number>;
};

/**
 * A single tool/action invocation within a wake cycle.
 *
 * One Episode may contain many ActionsTaken - the ReAct loop iterates
 * within a wake, calling tools, observing, deciding. Each individual
 * tool call is one ActionTaken record.
 */
export const ActionTakenSchema = z.object({
  /** Tool or sub-action name. */
  tool: z.string().min(1),
  /** Arbitrary structured input. Serialized at persist time. */
  input: z.unknown(),
  /** Whether the action completed without throwing. */
  succeeded: z.boolean(),
  /** Optional duration in ms - useful for budget accounting. */
  durationMs: z.number().int().min(0).optional(),
});

export type ActionTaken = {
  tool: string;
  input: unknown;
  succeeded: boolean;
  durationMs?: number;
};

/**
 * An observation returned by the world to the agent.
 *
 * Observations are deliberately separated from ActionsTaken because
 * the same action may yield multiple observations (e.g. a shell command
 * with stdout and stderr) and because some observations are unsolicited
 * (e.g. an external review arrives between wakes).
 */
export const ObservationSchema = z.object({
  /** Brief label for what kind of observation this is. */
  kind: z.string().min(1),
  /** Natural-language summary of what was observed. */
  summary: z.string().min(1),
  /** Optional pointer to a fuller artifact (file path, URL, episode id). */
  artifactRef: z.string().optional(),
});

export type Observation = {
  kind: string;
  summary: string;
  artifactRef?: string;
};

/**
 * A proposed change to the Charter, emitted by the reflect step.
 *
 * CharterDiff is intentionally narrow - we capture *intent to change*,
 * not the resulting Charter. The Charter Repository applies the diff
 * and increments the revision counter. This gives us a clean audit
 * trail of identity drift over time.
 */
export const CharterDiffSchema = z.object({
  /** Semantic memory entries to add (ids must be fresh). */
  addedSemanticMemory: z.array(z.string()).default([]),
  /** Semantic memory entry ids to remove. */
  removedSemanticMemoryIds: z.array(z.string()).default([]),
  /** Subgoal ids whose status changed; details captured in reflection. */
  subgoalStatusChanges: z.array(z.string()).default([]),
  /** Free-form prose describing the full diff for human review. */
  summary: z.string().min(1),
});

export type CharterDiff = {
  addedSemanticMemory: string[];
  removedSemanticMemoryIds: string[];
  subgoalStatusChanges: string[];
  summary: string;
};

/**
 * The Episode itself - one wake cycle, end to end.
 */
export const EpisodeSchema = z.object({
  /** Stable identifier (ULID or UUID). */
  id: z.string().min(1),

  /** Pointer back to the owning agent. */
  agentId: z.string().min(1),

  /** ISO timestamp of wake. */
  wakeAt: z.string().datetime(),

  /** Drives at start of wake. */
  drivesBefore: DriveVectorSchema,

  /** Output of the orient step. */
  policyDecision: PolicyDecisionSchema,

  /** Tool invocations that occurred during the act step. */
  actionsTaken: z.array(ActionTakenSchema).default([]),

  /** Observations gathered during the act step. */
  observations: z.array(ObservationSchema).default([]),

  /**
   * Natural-language reflection from the reflect step.
   * Answers: what just happened? what did I learn? what should change?
   */
  reflection: z.string().min(1),

  /** Proposed Charter changes, applied by the repository. */
  charterDiff: CharterDiffSchema,

  /** Drives at end of wake (after applyDelta from observations). */
  drivesAfter: DriveVectorSchema,

  /**
   * SCOPE LOCKS - the q-paper invariant.
   *
   * Explicit enumeration of what was NOT done in this wake. Required
   * for any tier-advancing work; optional but encouraged for routine
   * work. Examples from q-paper-neutron-scattering:
   *   "did NOT generate exact Lee 2026 target states"
   *   "did NOT touch billing"
   *   "did NOT change evidence labels"
   *
   * Scope locks are what make adversarial reviewer subagents tractable:
   * the reviewer doesn't have to guess what to check against, the actor
   * told them upfront.
   */
  scopeLocks: z.array(z.string()).default([]),

  /**
   * Evidence tier this Episode's work was operating at.
   * Reviewer routing depends on this - engineering-proxy work can be
   * self-reviewed; external-facing work requires an adversarial reviewer
   * subagent; human-reviewed work requires a `request_review_gate` action.
   */
  evidenceTier: EvidenceTierSchema,

  /** Token spend during this wake (input + output, all model calls). */
  tokensSpent: z.number().int().min(0).default(0),

  /** Cost in USD during this wake. */
  costUsd: z.number().min(0).default(0),

  /**
   * Optional pointer to a reviewer Episode that audited this one.
   * Set after an adversarial reviewer subagent has completed its pass.
   */
  reviewedByEpisodeId: z.string().optional(),
});

/**
 * Explicit Episode type, matching the convention across deepAgent schemas.
 */
export type Episode = {
  id: string;
  agentId: string;
  wakeAt: string;
  drivesBefore: DriveVector;
  policyDecision: PolicyDecision;
  actionsTaken: ActionTaken[];
  observations: Observation[];
  reflection: string;
  charterDiff: CharterDiff;
  drivesAfter: DriveVector;
  scopeLocks: string[];
  evidenceTier: EvidenceTier;
  tokensSpent: number;
  costUsd: number;
  reviewedByEpisodeId?: string;
};
