import mongoose, { Schema, model, type Model } from 'mongoose';
import {
  PlatformAttemptRegistration,
  PlatformAttribution,
  PlatformUsageEvent,
  PlatformAccountingConflictError,
  PLATFORM_ATTEMPT_STATES,
  PLATFORM_UNRESOLVED_REASONS,
  platformAccountingPayload,
  platformUsagePayload,
  type IPlatformAttempt,
  type IPlatformAttemptRegistration,
  type IPlatformAttemptRepository,
  type IPlatformUsageEventInput,
  type PlatformUnresolvedReason,
  type PlatformAttemptPage,
  type PlatformAttemptDiagnostics,
} from '@bike4mind/common';

const PlatformAttemptSchema = new Schema<IPlatformAttempt>(
  {
    providerCallId: { type: String, required: true },
    attribution: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator: (value: unknown) => PlatformAttribution.safeParse(value).success,
        message: 'Invalid platform attempt attribution',
      },
    },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    leaseExpiresAt: { type: Date, required: true },
    state: { type: String, enum: [...PLATFORM_ATTEMPT_STATES], required: true },
    dispatchedAt: { type: Date },
    usage: {
      type: Schema.Types.Mixed,
      validate: {
        validator: (value: unknown) =>
          value === undefined ||
          (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            PlatformUsageEvent.safeParse({ ...value, createdAt: new Date(), updatedAt: new Date() }).success),
        message: 'Invalid platform attempt usage',
      },
    },
    unresolvedReason: { type: String, enum: [...PLATFORM_UNRESOLVED_REASONS] },
  },
  { timestamps: true }
);
PlatformAttemptSchema.index({ providerCallId: 1 }, { unique: true });
PlatformAttemptSchema.index({ state: 1, leaseExpiresAt: 1 });
PlatformAttemptSchema.index({ 'attribution.executionId': 1, state: 1 });
// Mixed-field validators do not run for dotted writes or update pipelines.
PlatformAttemptSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  this.setOptions({ runValidators: true });
  const update = this.getUpdate();
  if (Array.isArray(update)) throw new Error('Platform attempt update pipelines are not supported');
  const protectedPath = (path: string) =>
    path === 'usage' || path === 'attribution' || path.startsWith('usage.') || path.startsWith('attribution.');
  for (const [operator, value] of Object.entries(update ?? {})) {
    const changes: [string, unknown][] =
      operator.startsWith('$') && value && typeof value === 'object' ? Object.entries(value) : [[operator, value]];
    for (const [path, destination] of changes) {
      if (
        (operator === '$rename' && typeof destination === 'string' && protectedPath(destination)) ||
        (protectedPath(path) &&
          (path.includes('.') || (operator.startsWith('$') && operator !== '$set' && operator !== '$setOnInsert')))
      ) {
        throw new Error('Platform attempt context must be replaced and validated as a whole');
      }
    }
  }
});
PlatformAttemptSchema.pre('validate', function () {
  PlatformAttemptRegistration.parse({
    providerCallId: this.providerCallId,
    attribution: this.attribution,
    provider: this.provider,
    model: this.model,
    leaseExpiresAt: this.leaseExpiresAt,
  });
  if ((this.state === 'usage_known' || this.state === 'recorded') !== Boolean(this.usage)) {
    throw new Error('Platform attempt usage state mismatch');
  }
});
export const PlatformAttempt =
  (mongoose.models['PlatformAttempt'] as Model<IPlatformAttempt> | undefined) ??
  model<IPlatformAttempt>('PlatformAttempt', PlatformAttemptSchema);

export class PlatformAttemptRepository implements IPlatformAttemptRepository {
  constructor(private readonly model: Model<IPlatformAttempt>) {}

  async register(input: IPlatformAttemptRegistration): Promise<IPlatformAttempt> {
    const parsed = PlatformAttemptRegistration.parse(input);
    let existing = await this.get(parsed.providerCallId);
    if (!existing) {
      try {
        const created = await this.model.create({ ...parsed, state: 'registered' });
        return created.toObject();
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        existing = await this.get(parsed.providerCallId);
        if (!existing) throw error;
      }
    }
    const registered = PlatformAttemptRegistration.parse({
      providerCallId: existing.providerCallId,
      attribution: existing.attribution,
      provider: existing.provider,
      model: existing.model,
      leaseExpiresAt: existing.leaseExpiresAt,
    });
    if (platformAccountingPayload(registered) !== platformAccountingPayload(parsed))
      throw new PlatformAccountingConflictError();
    return existing;
  }

  async get(providerCallId: string): Promise<IPlatformAttempt | null> {
    return this.model.findOne({ providerCallId }).lean<IPlatformAttempt>();
  }

  async claimDispatch(providerCallId: string, dispatchedAt: Date): Promise<boolean> {
    if (!Number.isFinite(dispatchedAt.getTime())) throw new Error('Invalid dispatch timestamp');
    const result = await this.model.updateOne(
      { providerCallId, state: 'registered', leaseExpiresAt: { $gt: dispatchedAt } },
      { $set: { state: 'dispatched', dispatchedAt } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  }

  async stageUsage(providerCallId: string, usage: IPlatformUsageEventInput): Promise<IPlatformAttempt> {
    const parsed = PlatformUsageEvent.parse({ ...usage, createdAt: new Date(), updatedAt: new Date() });
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...fact } = parsed;
    const current = await this.get(providerCallId);
    if (
      !current ||
      current.providerCallId !== fact.providerCallId ||
      current.provider !== fact.provider ||
      current.model !== fact.model ||
      platformAccountingPayload(current.attribution) !== platformAccountingPayload(fact.attribution) ||
      !current.dispatchedAt ||
      current.dispatchedAt.getTime() !== fact.dispatchedAt.getTime()
    ) {
      throw new PlatformAccountingConflictError();
    }
    if (current.usage) {
      if (platformUsagePayload(current.usage) !== platformUsagePayload(fact))
        throw new PlatformAccountingConflictError();
      return current;
    }
    const changed = await this.model
      .findOneAndUpdate(
        { providerCallId, state: { $in: ['dispatched', 'unresolved'] }, usage: { $exists: false } },
        { $set: { state: 'usage_known', usage: fact }, $unset: { unresolvedReason: '' } },
        { new: true, runValidators: true }
      )
      .lean<IPlatformAttempt>();
    if (changed) return changed;
    const raced = await this.get(providerCallId);
    if (!raced?.usage || platformUsagePayload(raced.usage) !== platformUsagePayload(fact))
      throw new PlatformAccountingConflictError();
    return raced;
  }

  async markRecorded(providerCallId: string): Promise<void> {
    const result = await this.model.updateOne(
      { providerCallId, state: 'usage_known', usage: { $exists: true } },
      { $set: { state: 'recorded' } },
      { runValidators: true }
    );
    if (!result.modifiedCount && (await this.get(providerCallId))?.state !== 'recorded')
      throw new PlatformAccountingConflictError();
  }

  async markUnresolved(providerCallId: string, reason: PlatformUnresolvedReason, expiredBefore?: Date): Promise<void> {
    if (!PLATFORM_UNRESOLVED_REASONS.includes(reason) || (reason === 'expired_intent' && !expiredBefore))
      throw new Error('Invalid unresolved reason');
    await this.model.updateOne(
      {
        providerCallId,
        state: { $in: ['registered', 'dispatched'] },
        ...(expiredBefore ? { leaseExpiresAt: { $lte: expiredBefore } } : {}),
      },
      { $set: { state: 'unresolved', unresolvedReason: reason } },
      { runValidators: true }
    );
  }

  async recoverable({
    now,
    limit,
    executionId,
    afterProviderCallId,
  }: {
    now: Date;
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformAttemptPage> {
    this.validateLimit(limit);
    const rows = await this.model
      .find({
        ...(executionId ? { 'attribution.executionId': executionId } : {}),
        ...(afterProviderCallId ? { providerCallId: { $gt: afterProviderCallId } } : {}),
        $or: [
          { state: 'usage_known' },
          { state: { $in: ['registered', 'dispatched'] }, leaseExpiresAt: { $lte: now } },
        ],
      })
      .sort({ providerCallId: 1 })
      .limit(limit + 1)
      .lean<IPlatformAttempt[]>();
    return this.page(rows, limit);
  }

  async diagnostics({
    limit,
    executionId,
    afterProviderCallId,
  }: {
    limit: number;
    executionId?: string;
    afterProviderCallId?: string;
  }): Promise<PlatformAttemptDiagnostics> {
    this.validateLimit(limit);
    const filter = { state: { $ne: 'recorded' }, ...(executionId ? { 'attribution.executionId': executionId } : {}) };
    const [rows, counts] = await Promise.all([
      this.model
        .find({ ...filter, ...(afterProviderCallId ? { providerCallId: { $gt: afterProviderCallId } } : {}) })
        .sort({ providerCallId: 1 })
        .limit(limit + 1)
        .lean<IPlatformAttempt[]>(),
      this.model.aggregate<{ _id: 'registered' | 'dispatched' | 'usage_known' | 'unresolved'; count: number }>([
        { $match: filter },
        { $group: { _id: '$state', count: { $sum: 1 } } },
      ]),
    ]);
    const byState = { registered: 0, dispatched: 0, usage_known: 0, unresolved: 0 };
    for (const row of counts) byState[row._id] = row.count;
    return { ...this.page(rows, limit), total: Object.values(byState).reduce((sum, count) => sum + count, 0), byState };
  }

  private page(rows: IPlatformAttempt[], limit: number): PlatformAttemptPage {
    return {
      attempts: rows.slice(0, limit),
      ...(rows.length > limit ? { nextCursor: rows[limit - 1].providerCallId } : {}),
    };
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid platform accounting page limit');
  }
}
export const platformAttemptRepository = new PlatformAttemptRepository(PlatformAttempt);
