import mongoose, { Model, model, Schema, Types, type FilterQuery } from 'mongoose';
import {
  ADMIN_APPROVAL_ACTIONS,
  ADMIN_APPROVAL_STATUSES,
  type AdminApproval,
  type AdminApprovalAction,
  type AdminApprovalClaimGuard,
  type AdminApprovalDecider,
  type AdminApprovalListQuery,
  type AdminApprovalRequester,
  type AdminApprovalStatus,
  type AdminApprovalUpdate,
  type AdminPermissionId,
  type IAdminApprovalRepository,
  type NewAdminApproval,
} from '@bike4mind/common';

type AdminApprovalDocumentShape = {
  _id: Types.ObjectId;
  action: AdminApprovalAction;
  paramsJson: string;
  paramsHash: string;
  summary: string;
  requestedBy: AdminApprovalRequester;
  reason: string;
  requiredPermission: AdminPermissionId;
  requiresFullAdmin: boolean;
  status: AdminApprovalStatus;
  expiresAt: Date;
  createdAt: Date;
  decidedBy?: AdminApprovalDecider;
  decidedAt?: Date;
  decisionReason?: string;
  executedAt?: Date;
  result?: unknown;
  error?: string;
};

const RequesterSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    selfIds: { type: [String], required: true },
  },
  { _id: false }
);

const DeciderSchema = new Schema(
  { id: { type: String, required: true }, name: { type: String, required: true } },
  { _id: false }
);

// No TTL: a decided record is audit evidence for the action it gated.
const AdminApprovalSchema = new Schema<AdminApprovalDocumentShape>(
  {
    action: { type: String, enum: ADMIN_APPROVAL_ACTIONS, required: true },
    paramsJson: { type: String, required: true },
    paramsHash: { type: String, required: true },
    summary: { type: String, required: true },
    requestedBy: { type: RequesterSchema, required: true },
    reason: { type: String, required: true },
    requiredPermission: { type: String, required: true },
    requiresFullAdmin: { type: Boolean, required: true },
    status: { type: String, enum: ADMIN_APPROVAL_STATUSES, required: true, default: 'pending' },
    expiresAt: { type: Date, required: true },
    decidedBy: { type: DeciderSchema },
    decidedAt: { type: Date },
    decisionReason: { type: String },
    executedAt: { type: Date },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
  },
  { collection: 'adminapprovals', timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

AdminApprovalSchema.index({ status: 1, expiresAt: 1 });
AdminApprovalSchema.index({ 'requestedBy.id': 1, createdAt: -1 });
AdminApprovalSchema.index({ createdAt: -1 });

export const AdminApprovalModel: Model<AdminApprovalDocumentShape> =
  (mongoose.models.AdminApproval as Model<AdminApprovalDocumentShape> | undefined) ??
  model<AdminApprovalDocumentShape>('AdminApproval', AdminApprovalSchema);

export const toAdminApproval = (document: AdminApprovalDocumentShape): AdminApproval => {
  const { _id, ...rest } = document;
  return {
    ...rest,
    id: String(_id),
    requestedBy: { ...document.requestedBy, selfIds: [...document.requestedBy.selfIds] },
  };
};

class AdminApprovalRepository implements IAdminApprovalRepository {
  constructor(private readonly approvalModel: Model<AdminApprovalDocumentShape>) {}

  async create(approval: NewAdminApproval): Promise<AdminApproval> {
    const created = await this.approvalModel.create({ ...approval, status: 'pending' });
    return toAdminApproval(created.toObject<AdminApprovalDocumentShape>());
  }

  async findById(id: string): Promise<AdminApproval | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const document = await this.approvalModel.findById(id).lean<AdminApprovalDocumentShape>();
    return document ? toAdminApproval(document) : null;
  }

  async list({ status, before, limit }: AdminApprovalListQuery): Promise<AdminApproval[]> {
    const filter: FilterQuery<AdminApprovalDocumentShape> = {
      ...(status ? { status } : {}),
      ...(before ? { createdAt: { $lt: before } } : {}),
    };
    const documents = await this.approvalModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<AdminApprovalDocumentShape[]>();
    return documents.map(toAdminApproval);
  }

  async claim(
    id: string,
    from: AdminApprovalStatus,
    to: AdminApprovalStatus,
    guard: AdminApprovalClaimGuard,
    set: AdminApprovalUpdate = {}
  ): Promise<AdminApproval | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const filter: FilterQuery<AdminApprovalDocumentShape> = {
      _id: new Types.ObjectId(id),
      status: from,
      expiresAt: { $gt: guard.now },
    };
    if (guard.requestedBy !== undefined) filter['requestedBy.id'] = guard.requestedBy;
    else if (guard.notRequestedBy !== undefined) filter['requestedBy.id'] = { $ne: guard.notRequestedBy };
    return this.transition(filter, to, set);
  }

  async finish(
    id: string,
    from: AdminApprovalStatus,
    to: AdminApprovalStatus,
    set: AdminApprovalUpdate = {}
  ): Promise<AdminApproval | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.transition({ _id: new Types.ObjectId(id), status: from }, to, set);
  }

  private async transition(
    filter: FilterQuery<AdminApprovalDocumentShape>,
    to: AdminApprovalStatus,
    set: AdminApprovalUpdate
  ): Promise<AdminApproval | null> {
    const document = await this.approvalModel
      .findOneAndUpdate(filter, { $set: { ...set, status: to } }, { new: true })
      .lean<AdminApprovalDocumentShape>();
    return document ? toAdminApproval(document) : null;
  }
}

export const adminApprovalRepository: IAdminApprovalRepository = new AdminApprovalRepository(AdminApprovalModel);
