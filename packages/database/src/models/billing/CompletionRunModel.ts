import { randomUUID } from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';

/** Who a completion run's spend is billed to: the user, or the organization an org-billed key draws on. */
export type CompletionRunOwnerType = CreditHolderType.User | CreditHolderType.Organization;

/**
 * A server-issued id grouping the completions of one multi-agent run (a root session plus the
 * workers it spawns). It is bound to the user and billing owner that minted it, so the completions
 * route can refuse a run another account created. Charges stay on the owner's balance and ledger.
 *
 * A run minted with `budgetCredits` also caps the whole run: `committedCredits` is what its settled
 * completions charged plus what its in-flight completions have claimed, and a completion is admitted
 * only while its claim fits under the budget (claimBudget). The PendingCreditHold row carries each
 * claim, so its settlement, refund or expired-hold sweep releases it exactly once
 * (apps/client/server/billing/completionCreditHolds.ts, apps/workers/src/cron/creditHoldSweep.ts).
 */
export type ICompletionRun = {
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
  };
}

export class CompletionRunRepository {
  async create(input: CreateCompletionRunInput): Promise<ICompletionRun> {
    const created = await CompletionRunModel.create({
      _id: randomUUID(),
      userId: input.userId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      apiKeyId: input.apiKeyId,
      rootSessionId: input.rootSessionId,
      ...(input.budgetCredits !== undefined && { budgetCredits: input.budgetCredits, committedCredits: 0 }),
    });
    return toCompletionRun(created.toObject());
  }

  async findById(runId: string): Promise<ICompletionRun | null> {
    const record = await CompletionRunModel.findById(runId).lean<CompletionRunRecord>();
    return record ? toCompletionRun(record) : null;
  }

  /**
   * Claims up to `wantedCredits` of the run's remaining budget, and at least `minimumCredits`, or
   * nothing. One atomic update sizes and takes the claim from the stored remainder, so concurrent
   * completions of one run never claim the same credits. Inside a transaction, concurrent claims on one
   * run conflict on its document and `withTransaction` retries them, as it already does for the balance.
   */
  async claimBudget(
    runId: string,
    wantedCredits: number,
    minimumCredits: number
  ): Promise<CompletionRunBudgetClaimOutcome> {
    const remaining = { $subtract: ['$budgetCredits', '$committedCredits'] };
    const before = await CompletionRunModel.findOneAndUpdate(
      {
        _id: runId,
        budgetCredits: { $exists: true },
        $expr: { $gte: [remaining, Math.max(1, minimumCredits)] },
      },
      [{ $set: { committedCredits: { $add: ['$committedCredits', { $min: [wantedCredits, remaining] }] } } }],
      { new: false }
    ).lean<CompletionRunRecord>();
    if (before?.budgetCredits !== undefined) {
      const credits = Math.min(wantedCredits, before.budgetCredits - (before.committedCredits ?? 0));
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
   * Moves `committedCredits` by `deltaCredits`, the unused part of a claim being released (never positive
   * in practice, since settlement caps a charge at its claim). Never refused.
   */
  async adjustCommitted(runId: string, deltaCredits: number): Promise<void> {
    if (deltaCredits === 0) return;
    await CompletionRunModel.updateOne(
      { _id: runId, budgetCredits: { $exists: true } },
      { $inc: { committedCredits: deltaCredits } }
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
      { new: true }
    ).lean<CompletionRunRecord>();
    if (record) return { kind: 'raised', run: toCompletionRun(record) };

    const current = await CompletionRunModel.findById(runId).select({ budgetCredits: 1 }).lean<CompletionRunRecord>();
    return current?.budgetCredits === undefined
      ? { kind: 'unbudgeted' }
      : { kind: 'not_higher', budgetCredits: current.budgetCredits };
  }
}

export const completionRunRepository = new CompletionRunRepository();
