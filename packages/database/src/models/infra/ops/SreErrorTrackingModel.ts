/**
 * SRE Error Tracking Model
 *
 * Tracks errors through the autonomous SRE pipeline:
 *   detected -> analyzing -> awaiting_approval -> fixing -> fixed/already_fixed/failed/wont_fix/dispatch_failed/low_confidence/rate_limited
 *   wont_fix -> revision_requested (reviewer can request retry; revisionCount cap prevents loops)
 *
 * Source-agnostic: handles both CloudWatch and GitHub issue origins.
 */

import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Build a repoSlug filter for queries.
 * Requires the v1->v2 migration script (scripts/migrate-sre-v2.mjs) to have
 * backfilled repoSlug on all existing docs. After migration, all docs have
 * repoSlug set, so a simple equality filter uses compound indexes efficiently.
 */
function repoSlugFilter(repoSlug: string): Record<string, unknown> {
  return { repoSlug };
}

export interface ISreErrorTracking {
  id: string;
  /** Source-agnostic normalized hash */
  errorFingerprint: string;
  /** Repository slug (owner/repo) - identifies which repo this error belongs to */
  repoSlug: string;
  /** Origin: CLOUDWATCH or GITHUB_ISSUE */
  source: 'CLOUDWATCH' | 'GITHUB_ISSUE';
  /** Source reference (GitHub issue URL or CloudWatch log group) */
  sourceRef: string;
  /** Pipeline status */
  status:
    | 'detected'
    | 'analyzing'
    | 'awaiting_approval'
    | 'fixing'
    | 'fixed'
    | 'already_fixed'
    | 'failed'
    | 'wont_fix'
    | 'dispatch_failed'
    | 'dry_run'
    | 'scope_blocked'
    | 'approval_expired'
    | 'revision_requested'
    | 'recurrence_detected'
    | 'low_confidence'
    | 'rate_limited'
    | 'dismissed';
  /** Number of revision attempts (incremented each time a reviewer requests changes) */
  revisionCount?: number;
  /** Number of CI retry attempts (incremented each time a typecheck/apply-fix CI failure is retried) */
  ciRetryCount?: number;
  /** Reviewer feedback that triggered the latest revision (audit trail) */
  reviewerFeedback?: string;
  /** Whether this tracking document was created in dry-run mode */
  dryRun?: boolean;
  /** Affected user IDs (CloudWatch source - from structured log metadata) */
  affectedUserIds: string[];
  /** LLM diagnosis result (embedded) */
  diagnosisResult?: {
    rootCause: string;
    proposedFix: string;
    confidence: number;
    riskAssessment: string;
    affectedFiles: Array<{
      filePath: string;
      before: string;
      after: string;
      kind?: 'insert' | 'replace' | 'create';
    }>;
    toolCalls?: Array<{
      tool: string;
      input: Record<string, unknown>;
      output: string;
    }>;
  };
  /** GitHub issue number (if applicable) */
  githubIssueNumber?: number;
  /** Fix PR number */
  fixPrNumber?: number;
  /** Fix PR SHA (for rollback detection) */
  fixPrSha?: string;
  /** When the fix PR was merged */
  fixMergedAt?: Date;
  /**
   * Human verdict on whether the merged SRE fix was actually correct (#271).
   * Recorded when a reviewer applies the `sre-fix-correct` / `sre-fix-incorrect`
   * label to the fix PR - a merge alone is not proof the fix was right. Feeds the
   * confidence-threshold tuning + activity dashboard items in #184.
   * Last-write-wins: applying the opposite label overrides a prior verdict.
   */
  fixVerdict?: {
    /** 'correct' or 'incorrect' - the reviewer's thumbs up/down */
    value: 'correct' | 'incorrect';
    /** GitHub login of the reviewer who applied the label */
    by: string;
    /** When the verdict was recorded */
    at: Date;
  };
  /** When affected users were notified */
  userNotifiedAt?: Date;
  /** GitHub Actions workflow run URL */
  workflowRunUrl?: string;
  /** When fix was dispatched to GitHub Actions */
  dispatchedAt?: Date;
  /** LLM token usage for cost tracking */
  llmTokensUsed?: { input: number; output: number };
  /** Whether GitHub Actions dispatch has been claimed (idempotency guard) */
  githubRunDispatched?: boolean;
  /** Chain-of-fix tracking for fix-loop detection */
  previousFixFingerprint?: string;
  /** PR numbers of prior merged autofixes that the recurrence guard detected (populated on transition to recurrence_detected) */
  priorFixPrNumbers?: number[];
  /** Reason provided by the admin when dismissing this tracking doc (populated on transition to 'dismissed') */
  dismissalReason?: string;
  /** Timestamp when this tracking doc was dismissed by an admin */
  dismissedAt?: Date;
  /** User ID of the admin who dismissed this tracking doc (for audit trail) */
  dismissedByUserId?: string;
  /**
   * ID of a prior dismissed tracking doc that this doc was created as a rerun of.
   * Set by claimForAnalysis when a dismissed doc exists for the same fingerprint
   * at the time of new doc creation. Enables audit queries like "show me the
   * rerun of this dismissed doc" without inferring from timestamps.
   */
  originatingFromDismissedDocId?: string;
  /** Error message for display */
  errorMessage?: string;
  /** Classification from Sentinel heuristics */
  classification?: 'HIGH' | 'MEDIUM' | 'LOW' | 'SKIP';
  /** Structured dry-run trace entries for pipeline debugging (only populated in dry-run mode) */
  dryRunTrace?: Array<{
    step: string;
    data: Record<string, unknown>;
    ts: number;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const SreErrorTrackingSchema = new mongoose.Schema(
  {
    errorFingerprint: { type: String, required: true },
    repoSlug: { type: String, required: true, default: 'MillionOnMars/lumina5' },
    source: { type: String, required: true, enum: ['CLOUDWATCH', 'GITHUB_ISSUE'] },
    sourceRef: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: [
        'detected',
        'analyzing',
        'awaiting_approval',
        'fixing',
        'fixed',
        'already_fixed',
        'failed',
        'wont_fix',
        'dispatch_failed',
        'dry_run',
        'scope_blocked',
        'approval_expired',
        'revision_requested',
        'recurrence_detected',
        'low_confidence',
        'rate_limited',
        'dismissed',
      ],
      default: 'detected',
    },
    affectedUserIds: { type: [String], default: [] },
    diagnosisResult: { type: mongoose.Schema.Types.Mixed },
    githubIssueNumber: { type: Number },
    fixPrNumber: { type: Number },
    fixPrSha: { type: String },
    fixMergedAt: { type: Date },
    fixVerdict: {
      type: {
        value: { type: String, enum: ['correct', 'incorrect'] },
        by: { type: String },
        at: { type: Date },
      },
    },
    userNotifiedAt: { type: Date },
    workflowRunUrl: { type: String },
    dispatchedAt: { type: Date },
    llmTokensUsed: {
      type: {
        input: { type: Number },
        output: { type: Number },
      },
    },
    githubRunDispatched: { type: Boolean },
    previousFixFingerprint: { type: String },
    errorMessage: { type: String },
    classification: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', 'SKIP'] },
    revisionCount: { type: Number, default: 0 },
    ciRetryCount: { type: Number, default: 0 },
    reviewerFeedback: { type: String },
    dryRun: { type: Boolean },
    dryRunTrace: { type: [mongoose.Schema.Types.Mixed] },
    priorFixPrNumbers: { type: [Number], default: [] },
    dismissalReason: { type: String },
    dismissedAt: { type: Date },
    dismissedByUserId: { type: String },
    originatingFromDismissedDocId: { type: mongoose.Schema.Types.ObjectId },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique compound index for dedup: prevents concurrent upserts from creating
// duplicate documents with the same repo+fingerprint+status triple.
SreErrorTrackingSchema.index({ repoSlug: 1, errorFingerprint: 1, status: 1 }, { unique: true });
// For querying by affected users
SreErrorTrackingSchema.index({ affectedUserIds: 1 });
// For looking up by PR number (scoped to repo - PR numbers are unique per-repo, not globally)
SreErrorTrackingSchema.index({ repoSlug: 1, fixPrNumber: 1 }, { sparse: true });
// Covers recurrence guard queries: { errorFingerprint, status: 'fixed', fixMergedAt: { $gte } }
SreErrorTrackingSchema.index({ repoSlug: 1, errorFingerprint: 1, status: 1, fixMergedAt: 1 });
// For staleness timeout detection
SreErrorTrackingSchema.index({ repoSlug: 1, status: 1, dispatchedAt: 1 });
// For querying recorded fix verdicts (#271) - feeds confidence tuning + dashboard.
// partialFilterExpression (not sparse): on a compound index sparse only skips a
// doc when ALL keys are absent, and repoSlug is required, so a sparse index would
// cover every doc. Filtering on fixVerdict.value indexes only the small subset of
// docs that actually carry a human verdict.
SreErrorTrackingSchema.index(
  { repoSlug: 1, 'fixVerdict.value': 1 },
  { partialFilterExpression: { 'fixVerdict.value': { $exists: true } } }
);
// TTL - auto-delete after 30 days
SreErrorTrackingSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

export const IN_FLIGHT_STATUSES = new Set<ISreErrorTracking['status']>([
  'detected',
  'analyzing',
  'awaiting_approval',
  'fixing',
  'revision_requested',
]);
export const RESOLVED_STATUSES = new Set<ISreErrorTracking['status']>(['fixed', 'already_fixed']);

export type ScanClassification = 'in-flight' | 'resolved' | 'dismissed' | 'open';

/**
 * Classifies a tracking doc status for scan dispatch decisions.
 * Uses ISreErrorTracking['status'] (string literal union) - NOT the SreTrackingStatus enum -
 * so the switch default `never` check gives compile-time exhaustiveness coverage.
 * If a new status is added without a case below, the assignment to `never` fails to compile.
 */
export function classifyForScan(status: ISreErrorTracking['status']): ScanClassification {
  switch (status) {
    case 'detected':
    case 'analyzing':
    case 'awaiting_approval':
    case 'fixing':
    case 'revision_requested':
      return 'in-flight';
    case 'fixed':
    case 'already_fixed':
      return 'resolved';
    case 'dismissed':
      return 'dismissed';
    case 'failed':
    case 'wont_fix':
    case 'dispatch_failed':
    case 'dry_run':
    case 'scope_blocked':
    case 'approval_expired':
    case 'recurrence_detected':
    case 'low_confidence':
    case 'rate_limited':
      return 'open';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'open';
    }
  }
}

export const RETRYABLE_STATUSES: ISreErrorTracking['status'][] = [
  'failed',
  'wont_fix',
  'dispatch_failed',
  'dry_run',
  'scope_blocked',
  'approval_expired',
  'recurrence_detected',
  'low_confidence',
  'rate_limited',
  // 'already_fixed' is intentionally absent - retrying would re-apply an
  // already-applied patch, looping back to already_fixed. If the prior fix was
  // wrong, that surfaces as a new issue, not a retry of the old one.
  // Cross-ref: claimForAnalysis $nin blocks new analysis; DISMISSABLE_STATUSES allows
  // admin cleanup. All three locations enforce the idempotency invariant together.
];

/**
 * Statuses from which a tracking doc may be dismissed by an admin.
 * 'dry_run' is intentionally excluded - dismissing dry-runs makes no sense (they're not real failures).
 * Cross-ref: RETRYABLE_STATUSES (retry also blocked for already_fixed) and
 * claimForAnalysis $nin (new analysis blocked). All three enforce the idempotency invariant.
 */
export const DISMISSABLE_STATUSES: ISreErrorTracking['status'][] = [
  'failed',
  'dispatch_failed',
  'wont_fix',
  // 'already_fixed' IS dismissable for admin cleanup/acknowledgement.
  // It is excluded from RETRYABLE_STATUSES (retry would loop) and from
  // claimForAnalysis $nin (new analysis blocked).
  'already_fixed',
  'scope_blocked',
  'approval_expired',
  'recurrence_detected',
  'low_confidence',
  'rate_limited',
];

class SreErrorTrackingRepository extends BaseRepository<ISreErrorTracking> {
  constructor(private sreErrorTrackingModel: mongoose.Model<ISreErrorTracking>) {
    super(sreErrorTrackingModel);
    this.model = sreErrorTrackingModel;
  }

  /**
   * Atomic dedup: create-or-skip for concurrent Lambda invocations.
   * Returns the document if this invocation won the race, null otherwise.
   * Catches E11000 duplicate key errors from concurrent upserts.
   */
  async claimForAnalysis(
    fingerprint: string,
    repoSlug: string,
    data: Partial<ISreErrorTracking>
  ): Promise<ISreErrorTracking | null> {
    const now = new Date();
    try {
      // Recurrence alert-fatigue guard: if a prior doc for this fingerprint is
      // in 'recurrence_detected' state (escalated by the recurrence guard), do
      // not claim a new analysis. The $nin filter below is not sufficient
      // because the upsert creates a NEW doc at status='analyzing', which is
      // allowed by the unique (fingerprint, status) compound index. An explicit
      // preflight check suppresses the Slack/GitHub alert storm per occurrence
      // until an operator retries the escalated doc via the admin UI (which
      // calls deleteTerminalByFingerprint first).
      //
      // TOCTOU note: a narrow race exists if two identical SQS messages arrive
      // simultaneously - both could pass this check before either upserts. The
      // blast radius is limited to a duplicate Slack alert; data integrity is
      // preserved by the atomic CAS (atomicTransition) in the handler which
      // prevents duplicate escalation side effects.
      const escalated = await this.model
        .findOne({ ...repoSlugFilter(repoSlug), errorFingerprint: fingerprint, status: 'recurrence_detected' })
        .lean();
      if (escalated) {
        return null;
      }

      // Look for a prior dismissed doc for this fingerprint. If found, stash its
      // _id on the new doc as originatingFromDismissedDocId for audit linkage.
      // A dismissed doc does NOT block new analysis (unlike failed/wont_fix/etc.)
      // because dismissal semantically means "admin reviewed and wants processing
      // to resume fresh" - see the 'dismissed' entry in $nin below.
      const dismissedPredecessor = await this.model
        .findOne({ ...repoSlugFilter(repoSlug), errorFingerprint: fingerprint, status: 'dismissed' })
        .sort({ dismissedAt: -1 })
        .select('_id')
        .lean<{ _id: mongoose.Types.ObjectId }>();

      // Do NOT set createdAt/updatedAt manually - the schema has `timestamps: true`
      // which auto-manages these fields, even on findOneAndUpdate with upsert.
      // Setting them explicitly causes a ConflictingUpdateOperators error.
      const result = await this.model.findOneAndUpdate(
        {
          ...repoSlugFilter(repoSlug),
          errorFingerprint: fingerprint,
          // 'dismissed' is excluded so dismissed docs don't match and block the
          // upsert - the unique (fingerprint, status) index allows (fp, dismissed)
          // and (fp, analyzing) to coexist. Dismissed doc preserved as audit
          // history, new analyzing doc proceeds independently.
          // 'already_fixed' is excluded to prevent a new analysis claim when a prior
          // idempotent run resolved this fingerprint - a new claim would loop
          // (apply -> already_fixed -> apply...). Cross-ref: RETRYABLE_STATUSES
          // (retry also blocked) and DISMISSABLE_FROM (admin cleanup path).
          // 'low_confidence', 'rate_limited', and 'wont_fix' are intentionally NOT
          // in this list. All three are retryable terminal states cleared by
          // deleteTerminalByFingerprint before retry - so a new analysis claim
          // correctly creates a fresh doc rather than blocking on the prior terminal doc.
          status: { $nin: ['analyzing', 'awaiting_approval', 'fixing', 'fixed', 'already_fixed', 'dismissed'] },
        },
        {
          $setOnInsert: {
            ...data,
            repoSlug,
            errorFingerprint: fingerprint,
            status: 'analyzing',
            ...(dismissedPredecessor && {
              originatingFromDismissedDocId: String(dismissedPredecessor._id),
            }),
          },
        },
        { upsert: true, returnDocument: 'after' }
      );

      if (!result) return null;

      const doc = result.toObject();
      // If the doc was just created (within 1 second), this invocation won the race
      const isNewDoc = Math.abs(doc.createdAt.getTime() - now.getTime()) < 1000;
      return isNewDoc ? doc : null;
    } catch (error: unknown) {
      // E11000 duplicate key error - another invocation won the race
      if (error instanceof Error && 'code' in error && (error as { code: number }).code === 11000) {
        return null;
      }
      throw error;
    }
  }

  async updateStatus(
    id: string,
    status: ISreErrorTracking['status'],
    updates?: Partial<ISreErrorTracking>
  ): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { status, ...updates } });
  }

  /**
   * Atomic state transition: only updates if current status matches expectedStatus.
   * Returns the updated document, or null if the transition was not possible.
   */
  async atomicTransition(
    id: string,
    expectedStatus: ISreErrorTracking['status'],
    newStatus: ISreErrorTracking['status'],
    updates?: Partial<ISreErrorTracking>
  ): Promise<ISreErrorTracking | null> {
    const result = await this.model.findOneAndUpdate(
      { _id: id, status: expectedStatus },
      { $set: { status: newStatus, ...updates } },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  /**
   * Dismiss a tracking doc - admin override that marks the doc as reviewed and
   * suppresses it from counting against the circuit breaker. Only transitions
   * from terminal-ish states (failed / dispatch_failed / wont_fix / scope_blocked /
   * approval_expired / recurrence_detected). Returns null if current status is
   * not dismissable (including already-dismissed - idempotent no-op).
   */
  async dismiss(id: string, reason: string, userId: string): Promise<ISreErrorTracking | null> {
    const result = await this.model.findOneAndUpdate(
      { _id: id, status: { $in: DISMISSABLE_STATUSES } },
      {
        $set: {
          status: 'dismissed',
          dismissalReason: reason,
          dismissedAt: new Date(),
          dismissedByUserId: userId,
        },
      },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  /**
   * Atomic revision claim: transitions to revision_requested.
   * Accepts 'fixed' (normal flow), 'failed' (retry after failed revision),
   * or 'wont_fix' (reviewer requesting another attempt after agent found no
   * effective changes; revisionCount cap prevents infinite loops).
   * Returns the updated document if claimed, null if:
   *   - status is not 'fixed', 'failed', or 'wont_fix'
   *   - no PR was created (fixPrNumber missing)
   *   - revisionCount >= maxRevisions (cap reached)
   *   - PR already merged (fixMergedAt exists)
   * Also resets githubRunDispatched for the new dispatch cycle.
   */
  async claimRevision(id: string, maxRevisions: number): Promise<ISreErrorTracking | null> {
    const result = await this.model.findOneAndUpdate(
      {
        _id: id,
        status: { $in: ['fixed', 'failed', 'wont_fix'] },
        fixPrNumber: { $exists: true },
        revisionCount: { $lt: maxRevisions },
        fixMergedAt: { $exists: false },
      },
      {
        $set: { status: 'revision_requested', githubRunDispatched: false },
        $inc: { revisionCount: 1 },
      },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  /**
   * Atomic CI retry claim: transitions 'fixing' -> 'revision_requested' when below maxCiRetries.
   * Uses $expr/$ifNull to handle docs where ciRetryCount is absent (treated as 0).
   * Returns null for duplicate callbacks AND when the retry cap is already reached.
   */
  async claimCiRetry(id: string, maxCiRetries: number): Promise<ISreErrorTracking | null> {
    const result = await this.model.findOneAndUpdate(
      {
        _id: id,
        status: 'fixing',
        $expr: { $lt: [{ $ifNull: ['$ciRetryCount', 0] }, maxCiRetries] },
      },
      {
        $set: { status: 'revision_requested' },
        $inc: { ciRetryCount: 1 },
      },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  async findByFingerprint(fingerprint: string, repoSlug?: string): Promise<ISreErrorTracking | null> {
    const filter: Record<string, unknown> = { errorFingerprint: fingerprint };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const result = await this.model.findOne(filter).sort({ createdAt: -1 });
    return result?.toObject() ?? null;
  }

  async findByPrNumber(prNumber: number, repoSlug?: string): Promise<ISreErrorTracking | null> {
    const filter: Record<string, unknown> = { fixPrNumber: prNumber };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const result = await this.model.findOne(filter);
    return result?.toObject() ?? null;
  }

  /**
   * Record a human verdict on whether the merged SRE fix was correct (#271).
   * Maps a `sre-fix-correct` / `sre-fix-incorrect` PR label back to the tracking
   * doc via its fixPrNumber. Last-write-wins: applying the opposite label
   * overrides the prior verdict. Returns the updated doc, or null when no
   * tracking doc exists for this PR (non-SRE PR - ignored gracefully).
   */
  async setFixVerdict(
    prNumber: number,
    verdict: NonNullable<ISreErrorTracking['fixVerdict']>,
    repoSlug?: string
  ): Promise<ISreErrorTracking | null> {
    const filter: Record<string, unknown> = { fixPrNumber: prNumber };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const result = await this.model.findOneAndUpdate(
      filter,
      { $set: { fixVerdict: verdict } },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  /**
   * Find stale dispatched jobs (no callback within timeout)
   */
  async findStaleDispatches(timeoutMinutes: number): Promise<ISreErrorTracking[]> {
    const threshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const results = await this.model.find({
      status: 'fixing',
      dispatchedAt: { $lt: threshold },
    });
    return results.map(doc => doc.toObject());
  }

  /**
   * Idempotency guard for GitHub dispatch: atomically set githubRunDispatched=true.
   * Returns the doc if successfully claimed, null if already claimed or status changed.
   */
  async claimDispatch(id: string): Promise<ISreErrorTracking | null> {
    const result = await this.model.findOneAndUpdate(
      { _id: id, status: 'fixing', githubRunDispatched: { $ne: true } },
      { $set: { githubRunDispatched: true } },
      { returnDocument: 'after' }
    );
    return result ? result.toObject() : null;
  }

  /**
   * Find stale documents by status using updatedAt threshold.
   * Generic version of findStaleDispatches for statuses that lack dispatchedAt.
   */
  async findStaleByStatus(status: ISreErrorTracking['status'], timeoutMinutes: number): Promise<ISreErrorTracking[]> {
    const threshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const results = await this.model.find({ status, updatedAt: { $lt: threshold } });
    return results.map(doc => doc.toObject());
  }

  /**
   * Check for recent fixes on the same files (fix-loop detection)
   */
  async hasRecentFixForFiles(fingerprint: string, repoSlug: string, withinHours: number = 24): Promise<boolean> {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000);
    const count = await this.model.countDocuments({
      ...repoSlugFilter(repoSlug),
      errorFingerprint: fingerprint,
      // 'already_fixed' is intentionally excluded: it means a prior run confirmed
      // the fix was a no-op, so the original 'fixed' doc is the authoritative
      // loop-detection signal. Including 'already_fixed' would double-count it.
      status: { $in: ['fixed', 'fixing'] },
      createdAt: { $gte: since },
    });
    return count > 0;
  }

  /**
   * Recurrence-guard query: find merged autofix PRs for this fingerprint within
   * the configured window. Used by both Layer 1 (count gate - derive count from
   * result length) and Layer 2 (LLM context enrichment - render prior fix
   * history in the Diagnostician prompt). Distinct from hasRecentFixForFiles
   * (which detects in-flight fix loops over a short 24h window).
   */
  async findMergedFixesForFingerprint(
    fingerprint: string,
    windowDays: number,
    repoSlug?: string
  ): Promise<Array<Pick<ISreErrorTracking, 'fixPrNumber' | 'fixMergedAt' | 'diagnosisResult'>>> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const filter: Record<string, unknown> = {
      errorFingerprint: fingerprint,
      status: 'fixed',
      fixMergedAt: { $exists: true, $gte: since },
    };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const docs = await this.model
      .find(filter)
      .select('fixPrNumber fixMergedAt diagnosisResult')
      .sort({ fixMergedAt: 1 })
      .lean<Array<Pick<ISreErrorTracking, 'fixPrNumber' | 'fixMergedAt' | 'diagnosisResult'>>>();
    return docs;
  }

  /**
   * Count consecutive failures (for circuit breaker).
   *
   * Looks at the most recent tracking docs (sorted by updatedAt desc) and counts
   * consecutive `failed` / `dispatch_failed` until a non-failure status breaks the chain.
   * Neutral statuses (scope_blocked, approval_expired, revision_requested, recurrence_detected,
   * dismissed) are skipped without resetting the counter.
   *
   * @param cooldownMinutes If provided, only considers docs updated within the last
   * `cooldownMinutes` minutes. This makes the "Cooldown" config actually enforce a time-based
   * reset - failures older than the window are ignored.
   *
   * If repoSlug is provided, scopes to that repo (also matching legacy docs
   * without repoSlug when querying the default repo). Otherwise counts globally.
   */
  async countConsecutiveFailures(repoSlug?: string, cooldownMinutes?: number): Promise<number> {
    const filter: Record<string, unknown> = {};
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    if (cooldownMinutes && cooldownMinutes > 0) {
      filter.updatedAt = { $gte: new Date(Date.now() - cooldownMinutes * 60 * 1000) };
    }
    // Limit raised from 10 -> 50 to avoid undercounting: in a retry storm, many
    // neutral-status docs (dismissed, revision_requested, etc.) could push real
    // failures past the window. 50 is safe for the CB's purpose while still
    // bounded for performance.
    const recentDocs = await this.model
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(50)
      .select('status')
      .lean<Array<{ status: string }>>();

    let count = 0;
    for (const doc of recentDocs) {
      if (doc.status === 'failed' || doc.status === 'dispatch_failed') {
        count++;
      } else if (
        doc.status === 'scope_blocked' ||
        doc.status === 'approval_expired' ||
        doc.status === 'revision_requested' ||
        doc.status === 'recurrence_detected' ||
        doc.status === 'already_fixed' ||
        doc.status === 'dismissed' ||
        doc.status === 'low_confidence' ||
        doc.status === 'rate_limited'
      ) {
        // Scope blocking is a configuration issue, approval expiry is a human delay,
        // revision_requested is an in-progress revision, recurrence_detected is an
        // intentional escalation, already_fixed is a prior-run idempotency skip,
        // dismissed is an admin override, low_confidence is an agent limitation,
        // rate_limited is an operational throttle - none are system failures, skip
        // without resetting the consecutive failure counter.
        continue;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Count fixes dispatched today for rate limiting.
   * If repoSlug is provided, scopes to that repo. Otherwise counts globally.
   */
  async countFixesDispatchedToday(repoSlug?: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // Intentionally excludes 'already_fixed': those docs consumed a GH Actions run but represent
    // idempotent no-ops (patch was already applied). Counting them would double-penalize fingerprints
    // that legitimately resolved between dispatch and execution. Blast radius: at most +1 untracked
    // dispatch per already_fixed per day; already_fixed is rare in practice.
    const filter: Record<string, unknown> = {
      status: { $in: ['fixing', 'fixed'] },
      dispatchedAt: { $gte: startOfDay },
    };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));

    return this.model.countDocuments(filter);
  }

  /**
   * Delete all terminal-status docs for a fingerprint so claimForAnalysis can create fresh.
   * Used by the retry flow - claimForAnalysis uses $setOnInsert which only works on new docs.
   */
  async deleteTerminalByFingerprint(fingerprint: string, repoSlug?: string): Promise<{ deletedCount: number }> {
    const filter: Record<string, unknown> = {
      errorFingerprint: fingerprint,
      status: { $in: RETRYABLE_STATUSES },
    };
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const result = await this.model.deleteMany(filter);
    return { deletedCount: result.deletedCount };
  }

  /**
   * Fetch the most-recent tracking doc for each fingerprint in a single batch query.
   * Returns a Map keyed by fingerprint. Fingerprints with no doc are absent from the map.
   * In-memory sort of the bounded result set (≤100 fingerprints) is intentional -
   * the existing { repoSlug, errorFingerprint, status } index covers the filter efficiently.
   */
  async findLatestByFingerprintBatch(
    fingerprints: string[],
    repoSlug: string
  ): Promise<Map<string, ISreErrorTracking>> {
    if (fingerprints.length === 0) return new Map();
    const docs = await this.model
      .find({ ...repoSlugFilter(repoSlug), errorFingerprint: { $in: fingerprints } })
      .sort({ createdAt: -1, _id: -1 })
      .lean<ISreErrorTracking[]>({ virtuals: true });
    const map = new Map<string, ISreErrorTracking>();
    for (const doc of docs) {
      if (!map.has(doc.errorFingerprint)) {
        map.set(doc.errorFingerprint, doc);
      }
    }
    return map;
  }

  /**
   * Fetch recent tracking documents for admin UI (list view - excludes heavy fields).
   */
  async findRecent(limit: number = 50, repoSlug?: string): Promise<ISreErrorTracking[]> {
    const filter: Record<string, unknown> = {};
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const docs = await this.model
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select({
        'diagnosisResult.toolCalls': 0,
        'diagnosisResult.affectedFiles': 0,
      })
      .lean<ISreErrorTracking[]>({ virtuals: true });
    return docs;
  }

  /**
   * Fetch a single tracking document by ID (full document for detail view).
   */
  async findFullById(id: string): Promise<ISreErrorTracking | null> {
    const doc = await this.model.findById(id).lean<ISreErrorTracking>({ virtuals: true });
    return doc ?? null;
  }
}

const SreErrorTrackingModel =
  (mongoose.models['SreErrorTracking'] as unknown as mongoose.Model<ISreErrorTracking>) ||
  mongoose.model<ISreErrorTracking>('SreErrorTracking', SreErrorTrackingSchema);

export const sreErrorTrackingRepository = new SreErrorTrackingRepository(SreErrorTrackingModel);

export default SreErrorTrackingModel;
