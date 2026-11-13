import mongoose, { Schema } from 'mongoose';

export const ORGANIZATION_AUDIT_ACTIONS = [
  'member.added',
  'member.removed',
  'member.role_changed',
  'owner.transferred',
  'invite.created',
  'invite.revoked',
  'policy.updated',
  'retention.deleted',
  'retention.media_detached',
  'billing.updated',
  'api_key.created',
  'api_key.revoked',
  'connector.connected',
  'connector.disconnected',
] as const;

export type OrganizationAuditAction = (typeof ORGANIZATION_AUDIT_ACTIONS)[number];
export interface OrganizationAuditEvent {
  organizationId: string;
  actorUserId: string;
  action: OrganizationAuditAction;
  targetId?: string;
  occurredAt: Date;
}

const schema = new Schema<OrganizationAuditEvent>(
  {
    organizationId: { type: String, required: true, immutable: true },
    actorUserId: { type: String, required: true, immutable: true },
    action: { type: String, enum: ORGANIZATION_AUDIT_ACTIONS, required: true, immutable: true },
    targetId: { type: String, immutable: true },
    occurredAt: { type: Date, required: true, default: Date.now, immutable: true },
  },
  { versionKey: false, strict: 'throw' }
);

schema.index({ organizationId: 1, occurredAt: -1, _id: -1 });
schema.index({ organizationId: 1, _id: -1 });
schema.index({ organizationId: 1, actorUserId: 1, occurredAt: -1, _id: -1 });
schema.index({ organizationId: 1, action: 1, occurredAt: -1, _id: -1 });
schema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function () {
    throw new Error('Organization audit events are append-only');
  }
);
schema.pre('save', function () {
  if (!this.isNew) throw new Error('Organization audit events are append-only');
});

export const OrganizationAuditEventModel =
  (mongoose.models.OrganizationAuditEvent as mongoose.Model<OrganizationAuditEvent> | undefined) ??
  mongoose.model<OrganizationAuditEvent>('OrganizationAuditEvent', schema);
