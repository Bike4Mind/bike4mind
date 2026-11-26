import { createHash, randomUUID } from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { BadRequestError, CompletionEvaluationStateSchema, CreditHolderType, HTTPError } from '@bike4mind/common';

/** Who a completion run's spend is billed to: the user, or the organization an org-billed key draws on. */
export type CompletionRunOwnerType = CreditHolderType.User | CreditHolderType.Organization;

/**
 * A server-issued id grouping the completions of one multi-agent run (a root session plus the
 * workers it spawns). It is bound to the user and billing owner that minted it, so the completions
 * route can refuse a run another account created. Charges stay on the owner's balance and ledger.
 *
 * A run minted with `budgetCredits` also caps admission into the run: `committedCredits` is what its settled
 * completions charged plus what its in-flight completions have claimed, and a completion is admitted
 * only while its claim fits under the budget (claimBudget). The PendingCreditHold row carries each
 * claim, so its settlement, refund or expired-hold sweep releases it exactly once
 * (apps/client/server/billing/completionCreditHolds.ts, apps/workers/src/cron/creditHoldSweep.ts).
 */
export type ICompletionRun = {
  evaluation?: import('@bike4mind/common').CompletionEvaluationState;
  runId: string;
  userId: string;
  ownerType: CompletionRunOwnerType;
  ownerId: string;
  apiKeyId?: string;
  rootSessionId?: string;
  /** The run's credit ceiling; absent for a run that only draws on the owner's balance. */
  budgetCredits?: number;
  /** Settled charges plus in-flight claims. Maintained only for a budgeted run. */
  committedCredits?: number;
  createdAt: Date;
};

export type CreateCompletionRunInput = Omit<ICompletionRun, 'runId' | 'createdAt' | 'committedCredits'>;

/** The outcome of claiming run budget for one completion. */
export type CompletionRunBudgetClaimOutcome =
  | { kind: 'unbudgeted' }
  | { kind: 'claimed'; credits: number }
  | { kind: 'exhausted'; budgetCredits: number; committedCredits: number };

/** The outcome of raising a run's budget. */
export type CompletionRunBudgetRaise =
  { kind: 'raised'; run: ICompletionRun } | { kind: 'unbudgeted' } | { kind: 'not_higher'; budgetCredits: number };

type CompletionRunRecord = Omit<ICompletionRun, 'runId'> & { _id: string; updatedAt: Date };

const CompletionRunSchema = new Schema<CompletionRunRecord>(
  {
    // A UUID rather than an ObjectId: the id is handed to callers, and its creation time should not be readable from it.
    _id: { type: String, required: true },
    userId: { type: String, required: true, immutable: true },
    ownerType: {
      type: String,
      required: true,
      immutable: true,
      enum: [CreditHolderType.User, CreditHolderType.Organization],
    },
    ownerId: { type: String, required: true, immutable: true },
    apiKeyId: { type: String, required: false, immutable: true },
    rootSessionId: { type: String, required: false, immutable: true },
    budgetCredits: { type: Number, required: false, min: 1 },
    committedCredits: { type: Number, required: false },
    evaluation: { type: Schema.Types.Mixed, required: false },
  },
  { timestamps: true, versionKey: false, strict: 'throw' }
);

// Erasure matches by user and by billing owner (dataSubject/registry/billing.ts).
CompletionRunSchema.index({ userId: 1 });
CompletionRunSchema.index({ ownerType: 1, ownerId: 1 });

export const CompletionRunModel: mongoose.Model<CompletionRunRecord> =
  (mongoose.models.CompletionRun as mongoose.Model<CompletionRunRecord> | undefined) ??
  mongoose.model<CompletionRunRecord>('CompletionRun', CompletionRunSchema);

function toCompletionRun(record: CompletionRunRecord): ICompletionRun {
  return {
    runId: record._id,
    userId: record.userId,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    ...(record.apiKeyId !== undefined && { apiKeyId: record.apiKeyId }),
    ...(record.rootSessionId !== undefined && { rootSessionId: record.rootSessionId }),
    ...(record.budgetCredits !== undefined && {
      budgetCredits: record.budgetCredits,
      committedCredits: record.committedCredits ?? 0,
    }),
    createdAt: record.createdAt,
    ...(record.evaluation && { evaluation: record.evaluation }),
  };
}

export class CompletionRunRepository {
  async create(input: CreateCompletionRunInput): Promise<ICompletionRun> {
    if (input.evaluation && !input.rootSessionId)
      throw new BadRequestError('Evaluation requires a stable rootSessionId.');
    const identity = input.evaluation
      ? createHash('sha256')
          .update(JSON.stringify(['evaluation-v1', input.userId, input.ownerType, input.ownerId, input.rootSessionId]))
          .digest('hex')
      : undefined;
    // Reuse the unique _id index so mint retries are safe before any new index deploys.
    const runId = identity
      ? `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`
      : randomUUID();
    try {
      const created = await CompletionRunModel.create(
        [
          {
            _id: runId,
            userId: input.userId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            apiKeyId: input.apiKeyId,
            rootSessionId: input.rootSessionId,
            ...(input.evaluation && { evaluation: input.evaluation }),
            ...(input.budgetCredits !== undefined && { budgetCredits: input.budgetCredits, committedCredits: 0 }),
          },
        ],
        { writeConcern: { w: 'majority' } }
      );
      return toCompletionRun(created[0].toObject());
    } catch (error) {
      if (!input.evaluation || !(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
      const existing = await this.findById(runId);
      const policy = (limits: import('@bike4mind/common').CompletionEvaluationLimits) =>
        JSON.stringify({
          version: limits.version,
          maxProviderUsd: limits.maxProviderUsd,
          maxTokens: limits.maxTokens,
          maxRequests: limits.maxRequests,
          modelIds: [...limits.modelIds].sort(),
        });
      if (
        !existing?.evaluation ||
        existing.userId !== input.userId ||
        existing.ownerId !== input.ownerId ||
        existing.ownerType !== input.ownerType ||
        existing.rootSessionId !== input.rootSessionId ||
        existing.budgetCredits !== input.budgetCredits ||
        policy(existing.evaluation.limits) !== policy(input.evaluation.limits)
      )
        throw new HTTPError(409, 'Evaluation identity already exists with a different policy.', {
          errorCode: 'evaluation_identity_conflict',
        });
      return existing;
    }
  }

  async findById(runId: string): Promise<ICompletionRun | null> {
    const record = await CompletionRunModel.findById(runId).lean<CompletionRunRecord>();
    return record ? toCompletionRun(record) : null;
  }

  async updateEvaluation(
    runId: string,
    change: (
      state: import('@bike4mind/common').CompletionEvaluationState
    ) => import('@bike4mind/common').CompletionEvaluationState
  ): Promise<import('@bike4mind/common').CompletionEvaluationState> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await this.findById(runId);
      if (!run?.evaluation) throw new Error('Evaluation run not found');
      const changed = change(structuredClone(run.evaluation));
      // `evaluation` is Mixed, so Mongoose validates nothing on it; the schema is the only guard.
      const next = CompletionEvaluationStateSchema.parse({ ...changed, revision: run.evaluation.revision + 1 });
      const result = await CompletionRunModel.updateOne(
        { _id: runId, 'evaluation.revision': run.evaluation.revision },
        { $set: { evaluation: next } },
        { runValidators: true, writeConcern: { w: 'majority' } }
      );
      if (result.modifiedCount === 1) return next;
    }
    throw new Error('Evaluation contention; retry receipt lookup');
  }

  /**
   * Claims up to `wantedCredits` of the run's remaining budget, and at least `minimumCredits`, or
   * nothing. One atomic update sizes and takes the claim from the stored remainder, so concurrent
   * completions of one run never claim the same credits. Inside a transaction, concurrent claims on one
   * run conflict on its document and `withTransaction` retries them, as it already does for the balance.
   *
   * `maxShareOfRemaining` (0-1] caps what one claim takes above its `minimumCredits` at that share of
   * the rest, so a claim that can shrink (a completion) leaves room for the run's concurrent work.
   * The share applies past the minimum, not to the whole remainder: a completion's minimum carries its
   * input cost, and halving the whole remainder would squeeze a long-context round to a short answer.
   * Must stay in sync with `claimableCredits`, which sizes the same claim on the read side.
   */
  async claimBudget(
    runId: string,
    wantedCredits: number,
    minimumCredits: number,
    maxShareOfRemaining = 1
  ): Promise<CompletionRunBudgetClaimOutcome> {
    if (!(maxShareOfRemaining > 0 && maxShareOfRemaining <= 1)) {
      throw new Error(`maxShareOfRemaining must be in (0, 1], got ${maxShareOfRemaining}`);
    }
    const remaining = { $subtract: ['$budgetCredits', '$committedCredits'] };
    const aboveMinimum = { $max: [0, { $subtract: [remaining, minimumCredits] }] };
    const shareCap = { $add: [minimumCredits, { $ceil: { $multiply: [aboveMinimum, maxShareOfRemaining] } }] };
    const before = await CompletionRunModel.findOneAndUpdate(
      {
        _id: runId,
        budgetCredits: { $exists: true },
        $expr: { $gte: [remaining, Math.max(1, minimumCredits)] },
      },
      [{ $set: { committedCredits: { $add: ['$committedCredits', { $min: [wantedCredits, remaining, shareCap] }] } } }],
      // update-validators-off: an aggregation pipeline update, which Mongoose cannot validate
      { new: false }
    ).lean<CompletionRunRecord>();
    if (before?.budgetCredits !== undefined) {
      const remainingCredits = before.budgetCredits - (before.committedCredits ?? 0);
      const credits = claimableCredits(remainingCredits, wantedCredits, minimumCredits, maxShareOfRemaining);
      return { kind: 'claimed', credits };
    }

    const current = await CompletionRunModel.findById(runId)
      .select({ budgetCredits: 1, committedCredits: 1 })
      .lean<CompletionRunRecord>();
    return current?.budgetCredits === undefined
      ? { kind: 'unbudgeted' }
      : { kind: 'exhausted', budgetCredits: current.budgetCredits, committedCredits: current.committedCredits ?? 0 };
  }

  /**
   * Moves `committedCredits` by `deltaCredits`: negative for the unused part of a claim being released,
   * positive when a completion's charge overran its claim (an estimate miss). Never refused.
   */
  async adjustCommitted(runId: string, deltaCredits: number): Promise<void> {
    if (deltaCredits === 0) return;
    await CompletionRunModel.updateOne(
      { _id: runId, budgetCredits: { $exists: true } },
      { $inc: { committedCredits: deltaCredits } },
      { runValidators: true }
    );
  }

  /**
   * Swaps a hold's run claim for what it charged: the whole claim back on a refund or sweep (0 charged),
   * or the unused part on settlement. The charge is what the ledger row recorded, after any floor at a
   * drained balance, so the committed total and the ledger's settled spend agree once nothing is in flight.
   */
  async releaseClaim(claim: { runId: string; credits: number }, chargedCredits: number): Promise<void> {
    await this.adjustCommitted(claim.runId, chargedCredits - claim.credits);
  }

  /** Raises a budgeted run's ceiling. Lowering it, or adding one to an unbudgeted run, is refused. */
  async raiseBudget(runId: string, budgetCredits: number): Promise<CompletionRunBudgetRaise> {
    const record = await CompletionRunModel.findOneAndUpdate(
      { _id: runId, budgetCredits: { $exists: true, $lt: budgetCredits } },
      { $set: { budgetCredits } },
      { new: true, runValidators: true }
    ).lean<CompletionRunRecord>();
    if (record) return { kind: 'raised', run: toCompletionRun(record) };

    const current = await CompletionRunModel.findById(runId).select({ budgetCredits: 1 }).lean<CompletionRunRecord>();
    return current?.budgetCredits === undefined
      ? { kind: 'unbudgeted' }
      : { kind: 'not_higher', budgetCredits: current.budgetCredits };
  }
}

/** The read-side mirror of the claim `claimBudget` takes in its update pipeline. */
function claimableCredits(
  remainingCredits: number,
  wantedCredits: number,
  minimumCredits: number,
  maxShareOfRemaining: number
): number {
  const aboveMinimum = Math.max(0, remainingCredits - minimumCredits);
  const shareCap = minimumCredits + Math.ceil(aboveMinimum * maxShareOfRemaining);
  return Math.min(wantedCredits, remainingCredits, shareCap);
}

export const completionRunRepository = new CompletionRunRepository();
