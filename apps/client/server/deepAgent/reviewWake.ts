import { randomUUID } from 'crypto';
import {
  ReviewVerdictSchema,
  evidenceTierRank,
  renderCharter,
  type Charter,
  type Episode,
  type EvidenceTier,
  type ReviewVerdict,
} from '@bike4mind/agents';
import { createSmallLLMService } from '@bike4mind/services';
import type { SmallLLMAdapters } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * Adversarial review wake - Quest 3 of the deep agent framework.
 *
 * An agent does not grade its own work (the q-paper invariant: self-grading
 * doesn't hold up). A reviewer pass reads a target episode with a REFUTING
 * stance - checking claims against scope locks and written memory - and
 * returns a verdict. The review itself is recorded as an episode (the audit
 * trail audits itself), the target episode gets a reviewer back-pointer, and
 * tier advancement is gated on approval: the charter's `currentTier` only
 * moves when a reviewer certifies a higher `tierGranted`.
 */

const logger = new Logger({ metadata: { component: 'deepAgent.reviewWake' } });

// Lenient parse of the reviewer's structured output - same discipline as
// reflect: a malformed field falls back conservatively, never fails the review.
const LenientVerdictSchema = ReviewVerdictSchema.extend({
  verdict: ReviewVerdictSchema.shape.verdict.catch('needs-changes'),
  issues: ReviewVerdictSchema.shape.issues.catch([]),
  tierGranted: ReviewVerdictSchema.shape.tierGranted.catch(undefined),
  summary: ReviewVerdictSchema.shape.summary.catch('(reviewer produced no summary)'),
});

/** Render the target episode for the reviewer - claims, actions, locks, memory. */
export function buildReviewPrompt(charter: Charter, episode: Episode): string {
  const tools = episode.actionsTaken.map(a => a.tool).join(', ') || '(none)';
  const observations = episode.observations
    .slice(0, 8)
    .map(o => `  - [${o.kind}] ${o.summary.slice(0, 600)}`)
    .join('\n');
  const locks = episode.scopeLocks.map(l => `  - ${l}`).join('\n') || '  (none declared)';
  // Render every id the episode CLAIMS to have written. An id no longer in the
  // charter (groomed/removed since) is surfaced explicitly - silently omitting
  // it would weaken the audit (the reviewer should know a claim's memory is gone).
  const memoryById = new Map(charter.semanticMemory.map(m => [m.id, m]));
  const memoryAdded = episode.charterDiff.addedSemanticMemory.length
    ? episode.charterDiff.addedSemanticMemory
        .map(id => {
          const m = memoryById.get(id);
          return m
            ? `  - (${m.evidenceTier}, conf ${m.confidence}) ${m.fact}`
            : `  - [entry ${id} no longer in charter memory — removed or groomed since this episode]`;
        })
        .join('\n')
    : '  (no memory written)';

  return [
    'You are an INDEPENDENT ADVERSARIAL REVIEWER auditing one wake cycle of an',
    'autonomous agent. Your stance is to REFUTE: assume claims are overstated',
    'until the evidence in front of you supports them. You are not the agent;',
    'do not defend its work.',
    '',
    'Audit checklist:',
    '1. Do the observations actually support the reflection and any memory written?',
    '2. Do the scope locks (what the agent says it did NOT do) contradict anything claimed?',
    '3. Is the evidence tier honest — sandbox work claimed as externally validated?',
    '4. Would this work survive a skeptical human reviewer at the granted tier?',
    '',
    '── Agent charter (context) ──',
    renderCharter(charter),
    '',
    '── Episode under review ──',
    `Policy: [${episode.policyDecision.actionKind}] ${episode.policyDecision.rationale}`,
    `Tools used: ${tools}`,
    `Observations:\n${observations || '  (none)'}`,
    `Reflection: ${episode.reflection}`,
    `Scope locks:\n${locks}`,
    `Memory written this wake:\n${memoryAdded}`,
    `Operating tier: ${episode.evidenceTier}`,
    '',
    'Return a verdict object:',
    "- `verdict`: 'approved' | 'needs-changes' | 'rejected'",
    '- `issues`: specific, checkable problems (empty only if approved clean)',
    '- `tierGranted`: the highest evidence tier you certify for this work',
    "  ('engineering-proxy' | 'engineering-scaled' | 'external-facing' | 'human-reviewed').",
    '  Be conservative — granting above the operating tier requires the evidence to clearly warrant it.',
    '- `summary`: one paragraph justifying the verdict',
  ].join('\n');
}

/** A verdict plus the LLM spend that produced it (for honest episode accounting). */
export interface ReviewStepResult {
  verdict: ReviewVerdict;
  tokensSpent: number;
  /** USD spend when the step can compute it; 0 otherwise. */
  costUsd: number;
}

/** Produce a verdict for an episode. Injectable for tests. */
export type ReviewVerdictStep = (charter: Charter, episode: Episode) => Promise<ReviewStepResult>;

/** LLM-backed verdict step (cheap structured call, refuting system stance). */
export function createLlmReviewStep(adapters: SmallLLMAdapters): ReviewVerdictStep {
  const llm = createSmallLLMService(adapters, logger);
  return async (charter, episode) => {
    const { data, metrics } = await llm.completeJSON(buildReviewPrompt(charter, episode), LenientVerdictSchema, {
      taskType: 'classification',
      temperature: 0,
      timeoutMs: 30_000,
      maxTokens: 4000,
    });
    return {
      verdict: data,
      tokensSpent: (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0),
      costUsd: 0, // no per-model pricing table at this layer; tokens carry the signal
    };
  };
}

/** Narrow persistence surface the review needs (MongoDeepAgentStore satisfies it). */
export interface ReviewStore {
  loadCharter(agentId: string): Promise<Charter | null>;
  saveCharter(charter: Charter): Promise<Charter>;
  appendEpisode(episode: Episode): Promise<Episode>;
  findEpisode(agentId: string, episodeId: string): Promise<Episode | null>;
  markEpisodeReviewed(agentId: string, episodeId: string, reviewerEpisodeId: string): Promise<void>;
}

export interface ReviewDeps {
  store: ReviewStore;
  reviewStep: ReviewVerdictStep;
  newEpisodeId?: () => string;
  now?: () => number;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  reviewerEpisodeId: string;
  /** Set when approval certified a higher tier and the charter advanced. */
  tierAdvanced?: { from: EvidenceTier; to: EvidenceTier };
}

/**
 * Run one adversarial review over a target episode:
 * verdict -> reviewer episode appended -> back-pointer set -> tier gate applied.
 */
export async function runReviewWake(agentId: string, episodeId: string, deps: ReviewDeps): Promise<ReviewOutcome> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const newId = deps.newEpisodeId ?? randomUUID;

  const charter = await deps.store.loadCharter(agentId);
  if (!charter) throw new Error(`runReviewWake: no charter for agent ${agentId}`);
  const target = await deps.store.findEpisode(agentId, episodeId);
  if (!target) throw new Error(`runReviewWake: no episode ${episodeId} for agent ${agentId}`);
  // Reviews are write-once - refuse upfront (before spending an LLM call)
  // rather than failing at the back-pointer write.
  if (target.reviewedByEpisodeId) {
    throw new Error(`runReviewWake: episode ${episodeId} already reviewed by ${target.reviewedByEpisodeId}`);
  }

  const { verdict, tokensSpent, costUsd } = await deps.reviewStep(charter, target);

  // The review is itself an episode - the audit trail audits itself.
  const reviewerEpisode: Episode = {
    id: newId(),
    agentId,
    wakeAt: nowIso,
    drivesBefore: charter.drives,
    policyDecision: {
      actionKind: 'adversarial_review',
      rationale: `Independent review of episode ${episodeId}`,
      expectedDriveDelta: {},
    },
    actionsTaken: [],
    observations: [
      {
        kind: 'review_verdict',
        summary: `${verdict.verdict}${verdict.tierGranted ? ` (tier granted: ${verdict.tierGranted})` : ''}: ${verdict.summary}`,
        artifactRef: episodeId,
      },
      ...verdict.issues.map(issue => ({ kind: 'review_issue', summary: issue })),
    ],
    reflection: verdict.summary,
    charterDiff: {
      addedSemanticMemory: [],
      removedSemanticMemoryIds: [],
      subgoalStatusChanges: [],
      summary: `adversarial review of ${episodeId}: ${verdict.verdict}`,
    },
    drivesAfter: charter.drives,
    scopeLocks: [
      'review-only: did NOT modify memory, goals, or drives',
      'did NOT execute tools',
      `did NOT advance tier beyond the gate${verdict.verdict === 'approved' ? '' : ' (verdict not approved)'}`,
    ],
    evidenceTier: target.evidenceTier,
    tokensSpent,
    costUsd,
  };
  const saved = await deps.store.appendEpisode(reviewerEpisode);
  await deps.store.markEpisodeReviewed(agentId, episodeId, saved.id);

  // Tier gate: deterministic - approval + a certified higher tier advances the
  // charter exactly one versioned write. Anything else leaves it untouched.
  let tierAdvanced: ReviewOutcome['tierAdvanced'];
  if (
    verdict.verdict === 'approved' &&
    verdict.tierGranted &&
    evidenceTierRank(verdict.tierGranted) > evidenceTierRank(charter.currentTier)
  ) {
    const from = charter.currentTier;
    await deps.store.saveCharter({
      ...charter,
      currentTier: verdict.tierGranted,
      version: charter.version + 1,
      updatedAt: nowIso,
    });
    tierAdvanced = { from, to: verdict.tierGranted };
  }

  return { verdict, reviewerEpisodeId: saved.id, tierAdvanced };
}
