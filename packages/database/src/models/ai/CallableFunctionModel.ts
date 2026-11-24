import {
  CALLABLE_FUNCTION_EXAMPLE_LIMITS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_OWNER_TYPES,
  CALLABLE_FUNCTION_PROTECTED_FIELDS,
  CALLABLE_FUNCTION_SLUG_PATTERN,
  CALLABLE_FUNCTION_STATES,
  CALLABLE_FUNCTION_TRUST_LABELS,
  CallableFunctionCapError,
  CallableFunctionProtectedFieldError,
  CallableFunctionSlugConflictError,
  FUNCTION_CONTRACT_LIMITS,
  type CallableFunctionCreateInput,
  type CallableFunctionExample,
  type CallableFunctionOwner,
  type CallableFunctionPromote,
  type CallableFunctionRepin,
  type ICallableFunctionDocument,
  type ICallableFunctionRepository,
  type ICallableFunctionSummary,
  type IMongoDocument,
  type RepositoryPatch,
  type RepositoryUpdateOptions,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export class CallableFunctionOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallableFunctionOwnerError';
  }
}

const OWNER_MISMATCH = 'A user-owned function must have ownerKey equal to userId';

const CallableFunctionPinSchema = new Schema(
  {
    artifactId: { type: String, required: true },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'The pinned version must be a whole number' },
    },
    contentHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    source: {
      type: String,
      required: true,
      validate: {
        validator: (source: string) => Buffer.byteLength(source, 'utf8') <= CALLABLE_FUNCTION_LIMITS.maxSourceBytes,
        message: `The pinned code is over ${CALLABLE_FUNCTION_LIMITS.maxSourceBytes} bytes`,
      },
    },
    pinnedAt: { type: Date, required: true },
    seq: { type: Number, min: 1, validate: { validator: Number.isInteger, message: 'seq must be a whole number' } },
    runtime: {
      type: new Schema(
        {
          kind: { type: String, required: true, maxlength: 40 },
          version: { type: String, required: true, maxlength: 40 },
          lockHash: { type: String, match: /^[0-9a-f]{64}$/ },
          packages: { type: [{ _id: false, name: String, version: String }], default: [] },
        },
        { _id: false }
      ),
    },
  },
  { _id: false }
);

const CallableFunctionExampleSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: FUNCTION_CONTRACT_LIMITS.maxDescriptionLength },
    input: { type: Schema.Types.Mixed, required: true },
    expected: { type: Schema.Types.Mixed, required: true },
    tolerance: { type: new Schema({ abs: { type: Number, min: 0 }, rel: { type: Number, min: 0 } }, { _id: false }) },
    citation: { type: String, required: true, maxlength: CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxCitationLength },
  },
  { _id: false }
);

const CallableFunctionSchema = new Schema<ICallableFunctionDocument>(
  {
    ownerType: { type: String, enum: CALLABLE_FUNCTION_OWNER_TYPES, required: true },
    ownerKey: { type: String, required: true },
    userId: { type: String, required: true },
    slug: { type: String, required: true, match: CALLABLE_FUNCTION_SLUG_PATTERN },
    description: { type: String, required: true, maxlength: FUNCTION_CONTRACT_LIMITS.maxDescriptionLength },
    state: { type: String, enum: CALLABLE_FUNCTION_STATES, default: 'draft' },
    enabled: { type: Boolean, required: true, default: true },
    pin: { type: CallableFunctionPinSchema, required: true },
    // Property names are identifiers (FUNCTION_PROPERTY_NAME_PATTERN), so no key escaping is needed.
    contract: { type: Schema.Types.Mixed, required: true },
    examples: {
      type: [CallableFunctionExampleSchema],
      default: undefined,
      validate: {
        validator: (examples?: unknown[]) =>
          !examples || examples.length <= CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxExamples,
        message: `At most ${CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxExamples} worked examples`,
      },
    },
    trustLabel: { type: String, enum: CALLABLE_FUNCTION_TRUST_LABELS },
    lastServerRun: { type: Schema.Types.Mixed },
    promoted: {
      type: new Schema(
        {
          seq: { type: Number, required: true, min: 1 },
          contract: { type: Schema.Types.Mixed, required: true },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: { virtuals: true, minimize: false },
    toObject: { virtuals: true, minimize: false },
  }
);

// Generic writers refuse the owner fields, so this holds after create too.
CallableFunctionSchema.pre('validate', function () {
  if (this.ownerKey !== this.userId) throw new CallableFunctionOwnerError(OWNER_MISMATCH);
});

// Its owner prefix serves the owner's list. One artifact may hold several tools, each under its own name.
CallableFunctionSchema.index({ ownerType: 1, ownerKey: 1, slug: 1 }, { unique: true, name: 'callablefn_owner_slug' });

export interface ICallableFunctionModel extends Model<ICallableFunctionDocument & IMongoDocument> {}
export const CallableFunction: ICallableFunctionModel =
  mongoose.models.CallableFunction ?? model<ICallableFunctionDocument>('CallableFunction', CallableFunctionSchema);

type FunctionDoc = ICallableFunctionDocument & IMongoDocument;

const SUMMARY_PROJECTION = { contract: 0, 'pin.source': 0, lastServerRun: 0, promoted: 0 };

const PROTECTED_FIELDS: ReadonlySet<string> = new Set(CALLABLE_FUNCTION_PROTECTED_FIELDS);

/** Throws when `data` (a whole doc, a partial, or dotted paths) or the `unset` option names a protected field. */
function assertNoProtectedFields(data: Record<string, unknown>, options?: Record<string, unknown>): void {
  const unset = Array.isArray(options?.unset) ? (options.unset as unknown[]) : [];
  for (const key of [...Object.keys(data), ...unset.filter((k): k is string => typeof k === 'string')]) {
    const root = key.split('.')[0]!;
    if (PROTECTED_FIELDS.has(root)) throw new CallableFunctionProtectedFieldError(root);
  }
}

function duplicateKeyError(error: unknown, data: CallableFunctionCreateInput): Error | null {
  const mongoError = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (mongoError?.code !== 11000) return null;
  if (mongoError.keyPattern?.slug || /callablefn_owner_slug/.test(mongoError.message ?? '')) {
    return new CallableFunctionSlugConflictError(data.slug);
  }
  return null;
}

const ownerFilter = (owner: CallableFunctionOwner) => ({ ownerType: owner.ownerType, ownerKey: owner.ownerKey });

class CallableFunctionRepository extends BaseRepository<FunctionDoc> implements ICallableFunctionRepository {
  // The base repository runs no schema validators on its updates; the three generic writers force them.
  update(data: Partial<FunctionDoc>, options?: RepositoryUpdateOptions<FunctionDoc>): Promise<FunctionDoc | null>;
  update(
    data: RepositoryPatch<FunctionDoc>,
    options?: RepositoryUpdateOptions<FunctionDoc>
  ): Promise<FunctionDoc | null>;
  async update(data: Partial<FunctionDoc>, options?: RepositoryUpdateOptions<FunctionDoc>) {
    assertNoProtectedFields(data, options);
    return super.update(data, { ...options, runValidators: true });
  }

  updateGuarded(
    data: Partial<FunctionDoc>,
    options?: RepositoryUpdateOptions<FunctionDoc>
  ): Promise<FunctionDoc | null>;
  updateGuarded(
    data: RepositoryPatch<FunctionDoc>,
    options?: RepositoryUpdateOptions<FunctionDoc>
  ): Promise<FunctionDoc | null>;
  async updateGuarded(data: Partial<FunctionDoc>, options?: RepositoryUpdateOptions<FunctionDoc>) {
    assertNoProtectedFields(data, options);
    return super.updateGuarded(data, { ...options, runValidators: true });
  }

  async updateMany(
    filter: Record<string, unknown>,
    data: Partial<FunctionDoc>,
    options?: RepositoryUpdateOptions<FunctionDoc>
  ) {
    assertNoProtectedFields(data, options);
    return super.updateMany(filter, data, { ...options, runValidators: true });
  }

  async create(data: CallableFunctionCreateInput) {
    if (data.ownerKey !== data.userId) throw new CallableFunctionOwnerError(OWNER_MISMATCH);
    try {
      return await super.create(data);
    } catch (error) {
      throw duplicateKeyError(error, data) ?? error;
    }
  }

  async createWithinOwnerCap(data: CallableFunctionCreateInput, cap: number): Promise<ICallableFunctionDocument> {
    const owner = { ownerType: data.ownerType, ownerKey: data.ownerKey };
    if ((await this.countForOwner(owner)) >= cap) throw new CallableFunctionCapError(cap);
    const created = await this.create(data);
    // Re-count once the insert is visible, as McpConnection's createWithinUserCap does: the last survivor
    // counted every other one, so survivors never pass the cap.
    if ((await this.countForOwner(owner)) > cap) {
      await this.model.deleteOne({ _id: created.id });
      throw new CallableFunctionCapError(cap);
    }
    return created;
  }

  async findByIdForOwner(id: string, owner: CallableFunctionOwner): Promise<ICallableFunctionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return this.findOne({ _id: id, ...ownerFilter(owner) });
  }

  async findBySlugForOwner(slug: string, owner: CallableFunctionOwner): Promise<ICallableFunctionSummary | null> {
    const doc = await this.model.findOne({ ...ownerFilter(owner), slug }, SUMMARY_PROJECTION);
    return doc ? (doc.toObject() as ICallableFunctionSummary) : null;
  }

  async listForOwner(
    owner: CallableFunctionOwner,
    filter: { artifactId?: string } = {}
  ): Promise<ICallableFunctionSummary[]> {
    const docs = await this.model
      .find(
        { ...ownerFilter(owner), ...(filter.artifactId !== undefined ? { 'pin.artifactId': filter.artifactId } : {}) },
        SUMMARY_PROJECTION
      )
      .sort({ createdAt: 1 });
    return docs.map(doc => doc.toObject() as ICallableFunctionSummary);
  }

  async countForOwner(owner: CallableFunctionOwner): Promise<number> {
    return this.model.countDocuments(ownerFilter(owner));
  }

  async setEnabled(
    id: string,
    owner: CallableFunctionOwner,
    enabled: boolean
  ): Promise<ICallableFunctionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ...ownerFilter(owner) },
      { $set: { enabled } },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async repin(
    id: string,
    owner: CallableFunctionOwner,
    expectedVersion: number,
    update: CallableFunctionRepin
  ): Promise<ICallableFunctionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    // The new pin has not passed a server run, so the function is a draft again until it is promoted.
    const result = await this.model.findOneAndUpdate(
      { _id: id, ...ownerFilter(owner), 'pin.version': expectedVersion },
      {
        $set: { pin: update.pin, contract: update.contract, description: update.description, state: 'draft' },
        $unset: { trustLabel: 1 },
      },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async setExamples(
    id: string,
    owner: CallableFunctionOwner,
    examples: CallableFunctionExample[]
  ): Promise<ICallableFunctionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ...ownerFilter(owner) },
      { $set: { examples } },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async promote(
    id: string,
    owner: CallableFunctionOwner,
    expected: { updatedAt: Date },
    update: CallableFunctionPromote
  ): Promise<ICallableFunctionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const at = update.lastServerRun.at;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ...ownerFilter(owner), updatedAt: expected.updatedAt },
      {
        $set: {
          'pin.seq': update.seq,
          'pin.runtime': update.runtime,
          lastServerRun: update.lastServerRun,
          trustLabel: update.trustLabel,
          promoted: { seq: update.seq, contract: update.contract, at },
          state: 'live',
        },
      },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async deleteForOwner(id: string, owner: CallableFunctionOwner): Promise<boolean> {
    if (!mongoose.isObjectIdOrHexString(id)) return false;
    const result = await this.model.deleteOne({ _id: id, ...ownerFilter(owner) });
    return result.deletedCount === 1;
  }
}

export const callableFunctionRepository = new CallableFunctionRepository(CallableFunction);

export default CallableFunction;
