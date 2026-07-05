/**
 * SRE Error Pattern Library Model
 *
 * Stores known error patterns with cached diagnoses so the Diagnostician
 * can skip LLM analysis for previously-seen-and-fixed errors.
 *
 * Patterns are created automatically when a fix is successfully merged,
 * and matched by errorFingerprint on subsequent occurrences.
 */

import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Build a repoSlug filter for queries.
 * Requires the v1->v2 migration script (scripts/migrate-sre-v2.mjs) to have
 * backfilled repoSlug on all existing docs.
 */
function repoSlugFilter(repoSlug: string): Record<string, unknown> {
  return { repoSlug };
}

export interface ISreErrorPattern {
  id: string;
  /** Source-agnostic normalized error fingerprint */
  errorFingerprint: string;
  /** Repository slug (owner/repo) - patterns are repo-scoped to prevent cross-repo leakage */
  repoSlug: string;
  /** Human-readable pattern name (auto-generated from error type) */
  name: string;
  /** Cached diagnosis from a previous successful fix */
  diagnosis: {
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
  };
  /** Original error message that created this pattern */
  errorMessage: string;
  /** How many times this pattern has been matched */
  matchCount: number;
  /** How many times the cached fix was applied successfully */
  successCount: number;
  /** How many times the cached fix failed */
  failureCount: number;
  /** Whether this pattern is active for matching */
  isActive: boolean;
  /** Last time this pattern was matched and used */
  lastMatchedAt?: Date;
  /** Tracking ID of the original fix that created this pattern */
  originTrackingId: string;
  /** PR number of the original fix */
  originPrNumber?: number;
  /**
   * Marked true when the recurrence guard determines the cached workaround is
   * ineffective (fingerprint recurred post-merge). Combined with `isActive: false`,
   * prevents the pattern from being reused until an operator resets it.
   */
  workaroundIneffective?: boolean;
  /**
   * GitHub issue number tracking the real root-cause investigation (not the
   * workaround). Set by the Diagnostician when emitting an escalation diagnosis
   * or by an operator via the /api/sre/patterns/[id] PATCH endpoint.
   */
  rootCauseTrackingIssue?: number;

  createdAt: Date;
  updatedAt: Date;
}

const SreErrorPatternSchema = new mongoose.Schema(
  {
    errorFingerprint: { type: String, required: true },
    repoSlug: { type: String, required: true, default: 'MillionOnMars/lumina5' },
    name: { type: String, required: true },
    diagnosis: {
      rootCause: { type: String, required: true },
      proposedFix: { type: String, required: true },
      confidence: { type: Number, required: true },
      riskAssessment: { type: String, required: true },
      affectedFiles: [
        {
          filePath: { type: String, required: true },
          before: { type: String, required: true },
          after: { type: String, required: true },
          kind: { type: String, enum: ['insert', 'replace', 'create'], default: 'replace' },
        },
      ],
    },
    errorMessage: { type: String, required: true },
    matchCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    lastMatchedAt: { type: Date },
    originTrackingId: { type: String, required: true },
    originPrNumber: { type: Number },
    workaroundIneffective: { type: Boolean, default: false },
    rootCauseTrackingIssue: { type: Number },
  },
  { timestamps: true }
);

// Unique compound index: patterns are repo-scoped to prevent cross-repo collision
SreErrorPatternSchema.index({ repoSlug: 1, errorFingerprint: 1 }, { unique: true });
// Lookup by fingerprint + active status (repo-scoped)
SreErrorPatternSchema.index({ repoSlug: 1, errorFingerprint: 1, isActive: 1 });
// For listing/admin queries (repo-scoped)
SreErrorPatternSchema.index({ repoSlug: 1, isActive: 1, matchCount: -1 });
// Auto-expire old patterns (90 days - configurable via maxPatternAgeDays)
SreErrorPatternSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7776000 });

const SreErrorPattern =
  mongoose.models.SreErrorPattern ?? mongoose.model<ISreErrorPattern>('SreErrorPattern', SreErrorPatternSchema);

class SreErrorPatternRepository extends BaseRepository<ISreErrorPattern> {
  constructor(private sreErrorPatternModel: mongoose.Model<ISreErrorPattern>) {
    super(sreErrorPatternModel);
    this.model = sreErrorPatternModel;
  }

  /**
   * Look up an active pattern by fingerprint with minimum confidence (repo-scoped).
   */
  async findActiveByFingerprint(
    fingerprint: string,
    repoSlug: string,
    minConfidence: number
  ): Promise<ISreErrorPattern | null> {
    const result = await this.model.findOne({
      ...repoSlugFilter(repoSlug),
      errorFingerprint: fingerprint,
      isActive: true,
      'diagnosis.confidence': { $gte: minConfidence },
    });
    return result ? result.toObject() : null;
  }

  /**
   * Record a pattern match - increment matchCount and update lastMatchedAt.
   */
  async recordMatch(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $inc: { matchCount: 1 }, $set: { lastMatchedAt: new Date() } });
  }

  /**
   * Record a successful fix from a cached pattern.
   */
  async recordSuccess(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $inc: { successCount: 1 } });
  }

  /**
   * Record a failed fix from a cached pattern. Deactivate if failure rate is too high.
   */
  async recordFailure(id: string): Promise<void> {
    const result = await this.model.findOneAndUpdate(
      { _id: id },
      { $inc: { failureCount: 1 } },
      { returnDocument: 'after' }
    );

    // Auto-deactivate if failure rate exceeds 50% (with at least 2 attempts)
    if (result) {
      const total = result.successCount + result.failureCount;
      if (total >= 2 && result.failureCount / total > 0.5) {
        await this.model.updateOne({ _id: id }, { $set: { isActive: false } });
      }
    }
  }

  /**
   * Create or update a pattern from a successful fix.
   * Uses upsert - if the fingerprint already exists, updates the diagnosis.
   */
  async upsertFromFix(
    fingerprint: string,
    repoSlug: string,
    data: {
      name: string;
      errorMessage: string;
      diagnosis: ISreErrorPattern['diagnosis'];
      originTrackingId: string;
      originPrNumber?: number;
    }
  ): Promise<ISreErrorPattern> {
    const result = await this.model.findOneAndUpdate(
      { ...repoSlugFilter(repoSlug), errorFingerprint: fingerprint },
      {
        // Do NOT set createdAt/updatedAt; timestamps: true handles them
        $set: {
          ...data,
          repoSlug,
          errorFingerprint: fingerprint,
          isActive: true,
        },
        $setOnInsert: {
          matchCount: 0,
          successCount: 0,
          failureCount: 0,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    return result!.toObject();
  }

  /**
   * Fetch patterns for admin UI, ordered by match count.
   */
  async findRecent(limit: number = 100, repoSlug?: string): Promise<ISreErrorPattern[]> {
    const filter: Record<string, unknown> = {};
    if (repoSlug) Object.assign(filter, repoSlugFilter(repoSlug));
    const docs = await this.model
      .find(filter)
      .sort({ matchCount: -1, updatedAt: -1 })
      .limit(limit)
      .lean<ISreErrorPattern[]>();
    return docs;
  }
}

export const sreErrorPatternRepository = new SreErrorPatternRepository(SreErrorPattern);
