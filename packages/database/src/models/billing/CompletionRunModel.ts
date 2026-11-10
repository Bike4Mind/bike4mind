import { randomUUID } from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';

/** Who a completion run's spend is billed to: the user, or the organization an org-billed key draws on. */
export type CompletionRunOwnerType = CreditHolderType.User | CreditHolderType.Organization;

/**
 * A server-issued id grouping the completions of one multi-agent run (a root session plus the
 * workers it spawns). It is bound to the user and billing owner that minted it, so the completions
 * route can refuse a run another account created. Attribution only: nothing is charged against it.
 */
export type ICompletionRun = {
  runId: string;
  userId: string;
  ownerType: CompletionRunOwnerType;
  ownerId: string;
  apiKeyId?: string;
  rootSessionId?: string;
  createdAt: Date;
};

export type CreateCompletionRunInput = Omit<ICompletionRun, 'runId' | 'createdAt'>;

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
  },
  { timestamps: true, versionKey: false, strict: 'throw' }
);

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
    });
    return toCompletionRun(created.toObject());
  }

  async findById(runId: string): Promise<ICompletionRun | null> {
    const record = await CompletionRunModel.findById(runId).lean<CompletionRunRecord>();
    return record ? toCompletionRun(record) : null;
  }
}

export const completionRunRepository = new CompletionRunRepository();
