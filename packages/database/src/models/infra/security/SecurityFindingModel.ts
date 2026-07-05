import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type SecurityFindingCategory = 'auth' | 'injection' | 'authz' | 'config' | 'code-absence' | 'misc';

export type SecurityFindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type SecurityFindingStatus = 'new' | 'persisting' | 'resolved' | 'false_positive';

export type SecurityFindingRunTrigger = 'manual' | 'scheduled';

export type SecurityFindingRunStatus = 'running' | 'completed' | 'failed';

export interface ISecurityFindingDocument extends IMongoDocument {
  // Deterministic dedup key: `category::endpoint::title`. Stable across runs.
  fingerprint: string;
  stage: string;
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  endpoint: string;
  title: string;
  details: string;
  reproduction: string;
  status: SecurityFindingStatus;
  // Name of the probe that surfaced this finding. Used to scope auto-resolution to runs
  // whose probe set actually executed, preventing partial-run false-resolutions.
  sourceProbe: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  // Set when an already-resolved finding re-surfaces in a later run (regression). Null
  // for findings that have never been resolved-then-re-detected.
  lastRegressionAt?: Date | null;
  runId: string;
  orgId?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISecurityFindingRunDocument extends IMongoDocument {
  runId: string;
  stage: string;
  targetUrl: string;
  trigger: SecurityFindingRunTrigger;
  startedAt: Date;
  finishedAt?: Date;
  status: SecurityFindingRunStatus;
  findingCounts: {
    new: number;
    persisting: number;
    resolved: number;
  };
  probesRun: string[];
  // Per-probe error messages collected during the run. Distinct from `error`
  // which is set only when the run itself fails.
  probeErrors: string[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SecurityFindingSchema = new mongoose.Schema<ISecurityFindingDocument>(
  {
    fingerprint: { type: String, required: true, unique: true },
    stage: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['auth', 'injection', 'authz', 'config', 'code-absence', 'misc'],
    },
    severity: {
      type: String,
      required: true,
      enum: ['P0', 'P1', 'P2', 'P3'],
    },
    endpoint: { type: String, required: true },
    title: { type: String, required: true },
    details: { type: String, required: true },
    reproduction: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['new', 'persisting', 'resolved', 'false_positive'],
      default: 'new',
    },
    sourceProbe: { type: String, required: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    lastRegressionAt: { type: Date, default: null },
    runId: { type: String, required: true },
    orgId: { type: String },
    githubIssueNumber: { type: Number },
    githubIssueUrl: { type: String },
  },
  { timestamps: true }
);

SecurityFindingSchema.index({ stage: 1, status: 1, lastSeenAt: -1 });
SecurityFindingSchema.index({ runId: 1 });
SecurityFindingSchema.index({ status: 1 });
SecurityFindingSchema.index({ stage: 1, sourceProbe: 1, status: 1 });

const SecurityFindingRunSchema = new mongoose.Schema<ISecurityFindingRunDocument>(
  {
    runId: { type: String, required: true, unique: true },
    stage: { type: String, required: true },
    targetUrl: { type: String, required: true },
    trigger: { type: String, required: true, enum: ['manual', 'scheduled'] },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    status: {
      type: String,
      required: true,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
    },
    findingCounts: {
      new: { type: Number, default: 0 },
      persisting: { type: Number, default: 0 },
      resolved: { type: Number, default: 0 },
    },
    probesRun: { type: [String], default: [] },
    probeErrors: { type: [String], default: [] },
    error: { type: String },
  },
  { timestamps: true }
);

SecurityFindingRunSchema.index({ stage: 1, startedAt: -1 });
SecurityFindingRunSchema.index({ stage: 1, status: 1, startedAt: -1 });

export const SecurityFinding: Model<ISecurityFindingDocument> =
  mongoose.models.SecurityFinding || mongoose.model<ISecurityFindingDocument>('SecurityFinding', SecurityFindingSchema);

export const SecurityFindingRun: Model<ISecurityFindingRunDocument> =
  mongoose.models.SecurityFindingRun ||
  mongoose.model<ISecurityFindingRunDocument>('SecurityFindingRun', SecurityFindingRunSchema);

export class SecurityFindingRepository extends BaseRepository<ISecurityFindingDocument> {
  constructor(model: Model<ISecurityFindingDocument>) {
    super(model);
  }

  async findByFingerprint(fingerprint: string): Promise<ISecurityFindingDocument | null> {
    const doc = await this.model.findOne({ fingerprint }).exec();
    return doc ? (doc.toJSON() as ISecurityFindingDocument) : null;
  }

  /**
   * Atomic upsert keyed on `fingerprint`. Single round-trip via aggregation pipeline update:
   * eliminates the read-then-write race where two concurrent ingest calls would both see
   * `existing === null`, both `create`, and one would silently lose to the unique index.
   *
   * Status semantics:
   *   - Doc absent -> status: 'new', firstSeenAt: now
   *   - Doc was 'false_positive' -> preserved (manual classification, not auto-overridable)
   *   - Doc was 'resolved' -> flips to 'persisting' (a regression, must surface in the UI),
   *     and `lastRegressionAt` is set so operators can distinguish persisting-from-new vs
   *     persisting-after-fix
   *   - Otherwise -> 'persisting'
   */
  async upsertByFingerprint(
    fingerprint: string,
    data: Omit<ISecurityFindingDocument, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'status'> & {
      firstSeenAt?: Date;
    }
  ): Promise<{ finding: ISecurityFindingDocument; isNew: boolean }> {
    const firstSeenAt = data.firstSeenAt ?? data.lastSeenAt;

    const result = await this.model
      .findOneAndUpdate(
        { fingerprint },
        [
          {
            $set: {
              // Insert-only fields preserved on update via $ifNull.
              fingerprint: { $ifNull: ['$fingerprint', fingerprint] },
              stage: { $ifNull: ['$stage', data.stage] },
              category: { $ifNull: ['$category', data.category] },
              endpoint: { $ifNull: ['$endpoint', data.endpoint] },
              title: { $ifNull: ['$title', data.title] },
              firstSeenAt: { $ifNull: ['$firstSeenAt', firstSeenAt] },
              // Always-update fields.
              lastSeenAt: data.lastSeenAt,
              runId: data.runId,
              severity: data.severity,
              details: data.details,
              reproduction: data.reproduction,
              sourceProbe: data.sourceProbe,
              // Status transition matrix (see method docstring).
              status: {
                $switch: {
                  branches: [
                    { case: { $eq: [{ $type: '$status' }, 'missing'] }, then: 'new' },
                    { case: { $eq: ['$status', 'false_positive'] }, then: 'false_positive' },
                  ],
                  default: 'persisting',
                },
              },
              // Stamp regression timestamp when transitioning resolved -> persisting; otherwise
              // preserve any existing value (or null on first insert).
              lastRegressionAt: {
                $cond: {
                  if: { $eq: ['$status', 'resolved'] },
                  then: data.lastSeenAt,
                  else: { $ifNull: ['$lastRegressionAt', null] },
                },
              },
            },
          },
        ],
        { upsert: true, new: true, includeResultMetadata: true }
      )
      .exec();

    const value = result?.value;
    if (!value) {
      throw new Error(`Failed to upsert finding ${fingerprint}`);
    }
    // `updatedExisting` is true on update, false on insert: the atomic way to distinguish.
    const isNew = result?.lastErrorObject?.updatedExisting === false;
    return { finding: value.toJSON() as ISecurityFindingDocument, isNew };
  }

  /**
   * Bulk upsert variant used by the ingest endpoint to collapse N findings into a single
   * round-trip. Returns counts of new vs persisting findings plus the upserted documents
   * (which the caller still needs for the GitHub auto-issuer).
   */
  async bulkUpsertByFingerprint(
    findings: Array<
      Omit<ISecurityFindingDocument, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'status'> & {
        firstSeenAt?: Date;
      }
    >
  ): Promise<{ findings: ISecurityFindingDocument[]; newCount: number; persistingCount: number }> {
    if (findings.length === 0) {
      return { findings: [], newCount: 0, persistingCount: 0 };
    }

    const ops = findings.map(data => {
      const firstSeenAt = data.firstSeenAt ?? data.lastSeenAt;
      return {
        updateOne: {
          filter: { fingerprint: data.fingerprint },
          update: [
            {
              $set: {
                fingerprint: { $ifNull: ['$fingerprint', data.fingerprint] },
                stage: { $ifNull: ['$stage', data.stage] },
                category: { $ifNull: ['$category', data.category] },
                endpoint: { $ifNull: ['$endpoint', data.endpoint] },
                title: { $ifNull: ['$title', data.title] },
                firstSeenAt: { $ifNull: ['$firstSeenAt', firstSeenAt] },
                lastSeenAt: data.lastSeenAt,
                runId: data.runId,
                severity: data.severity,
                details: data.details,
                reproduction: data.reproduction,
                sourceProbe: data.sourceProbe,
                status: {
                  $switch: {
                    branches: [
                      { case: { $eq: [{ $type: '$status' }, 'missing'] }, then: 'new' },
                      { case: { $eq: ['$status', 'false_positive'] }, then: 'false_positive' },
                    ],
                    default: 'persisting',
                  },
                },
                lastRegressionAt: {
                  $cond: {
                    if: { $eq: ['$status', 'resolved'] },
                    then: data.lastSeenAt,
                    else: { $ifNull: ['$lastRegressionAt', null] },
                  },
                },
              },
            },
          ],
          upsert: true,
        },
      };
    });

    const result = await this.model.bulkWrite(ops);
    const newCount = result.upsertedCount ?? 0;
    const persistingCount = (result.matchedCount ?? 0) - (result.upsertedCount ?? 0);

    // Re-read the persisted docs in one query so the caller can fan them out to the
    // GitHub issuer. Indexed by fingerprint (unique) so this is a fast fetch.
    const fingerprints = findings.map(f => f.fingerprint);
    const docs = await this.model.find({ fingerprint: { $in: fingerprints } }).exec();
    return {
      findings: docs.map(d => d.toJSON() as ISecurityFindingDocument),
      newCount,
      persistingCount: Math.max(0, persistingCount),
    };
  }

  /**
   * Mark active findings as resolved when they were not reported by the current run.
   *
   * Scoped to findings whose `sourceProbe` is in the `probesExecuted` list, so a partial
   * run (where some probes failed before completing) does not auto-resolve findings owned by
   * probes that never ran. Manual classifications (`false_positive`/`resolved`) are preserved.
   */
  async markMissingAsResolved(stage: string, runId: string, probesExecuted: string[]): Promise<number> {
    if (probesExecuted.length === 0) return 0;
    const result = await this.model
      .updateMany(
        {
          stage,
          status: { $in: ['new', 'persisting'] },
          sourceProbe: { $in: probesExecuted },
          runId: { $ne: runId },
        },
        { $set: { status: 'resolved' } }
      )
      .exec();
    return result.modifiedCount ?? 0;
  }

  /**
   * Returns active (non-resolved, non-false-positive) findings for a stage. Capped at
   * `limit` to prevent unbounded response sizes: the dashboard is a triage surface, not
   * a complete history view; long-tail findings should be reviewed and classified.
   */
  async findActiveByStage(stage: string, limit = 500): Promise<ISecurityFindingDocument[]> {
    const docs = await this.model
      .find({ stage, status: { $nin: ['resolved', 'false_positive'] } })
      .sort({ severity: 1, lastSeenAt: -1 })
      .limit(limit)
      .exec();
    return docs.map(d => d.toJSON() as ISecurityFindingDocument);
  }

  async setGithubIssue(fingerprint: string, githubIssueNumber: number, githubIssueUrl: string): Promise<void> {
    await this.model.updateOne({ fingerprint }, { $set: { githubIssueNumber, githubIssueUrl } }).exec();
  }
}

export class SecurityFindingRunRepository extends BaseRepository<ISecurityFindingRunDocument> {
  constructor(model: Model<ISecurityFindingRunDocument>) {
    super(model);
  }

  async findByRunId(runId: string): Promise<ISecurityFindingRunDocument | null> {
    const doc = await this.model.findOne({ runId }).exec();
    return doc ? (doc.toJSON() as ISecurityFindingRunDocument) : null;
  }

  async findRecentByStage(stage: string, limit = 10): Promise<ISecurityFindingRunDocument[]> {
    const docs = await this.model.find({ stage }).sort({ startedAt: -1 }).limit(limit).exec();
    return docs.map(d => d.toJSON() as ISecurityFindingRunDocument);
  }

  /**
   * Find the last fully-completed (or failed) run for cooldown purposes. Skips 'running'
   * runs so a stuck/abandoned in-flight record does not lock the admin "Run Now" button.
   */
  async findLastTerminalRun(stage: string): Promise<ISecurityFindingRunDocument | null> {
    const doc = await this.model
      .findOne({ stage, status: { $in: ['completed', 'failed'] } })
      .sort({ startedAt: -1 })
      .exec();
    return doc ? (doc.toJSON() as ISecurityFindingRunDocument) : null;
  }

  /**
   * Check whether a run is currently in flight for this stage. Treats `running` records older
   * than `staleAfterMs` as abandoned and ignores them. Caller should reap stale runs before
   * proceeding.
   */
  async findActiveRun(stage: string, staleAfterMs: number): Promise<ISecurityFindingRunDocument | null> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const doc = await this.model
      .findOne({ stage, status: 'running', startedAt: { $gte: cutoff } })
      .sort({ startedAt: -1 })
      .exec();
    return doc ? (doc.toJSON() as ISecurityFindingRunDocument) : null;
  }

  /**
   * Mark stuck `running` runs older than `staleAfterMs` as `failed` so they do not block
   * future single-flight checks. Returns the number of runs reaped.
   */
  async reapStaleRuns(stage: string, staleAfterMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const result = await this.model
      .updateMany(
        { stage, status: 'running', startedAt: { $lt: cutoff } },
        { $set: { status: 'failed', finishedAt: new Date(), error: 'Run timed out (reaped)' } }
      )
      .exec();
    return result.modifiedCount ?? 0;
  }

  async completeRun(
    runId: string,
    findingCounts: ISecurityFindingRunDocument['findingCounts'],
    probesRun: string[],
    probeErrors: string[] = []
  ): Promise<void> {
    await this.model
      .updateOne(
        { runId },
        {
          $set: {
            status: 'completed',
            finishedAt: new Date(),
            findingCounts,
            probesRun,
            probeErrors,
          },
        }
      )
      .exec();
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.model.updateOne({ runId }, { $set: { status: 'failed', finishedAt: new Date(), error } }).exec();
  }
}

export const securityFindingRepository = new SecurityFindingRepository(SecurityFinding);
export const securityFindingRunRepository = new SecurityFindingRunRepository(SecurityFindingRun);
