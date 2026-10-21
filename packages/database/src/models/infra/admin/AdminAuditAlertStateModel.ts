import mongoose, { Model, model, Schema } from 'mongoose';
import type { AdminAuditAlertState, IAdminAuditAlertStateRepository } from '@bike4mind/common';

// One document, keyed by a fixed string _id, so the collection needs no index beyond the default.
const STATE_ID = 'admin-audit-alerts';

type AdminAuditAlertStateRecord = {
  _id: string;
  cursor: { occurredAt: Date; id: string };
  openBursts: Array<{ actorUserId: string; lastGrantAt: Date }>;
  updatedAt: Date;
};

const AdminAuditAlertStateSchema = new Schema<AdminAuditAlertStateRecord>(
  {
    _id: { type: String, required: true },
    cursor: {
      occurredAt: { type: Date, required: true },
      id: { type: String, required: true },
    },
    openBursts: {
      type: [
        { _id: false, actorUserId: { type: String, required: true }, lastGrantAt: { type: Date, required: true } },
      ],
      default: [],
    },
  },
  { collection: 'adminauditalertstate', timestamps: { createdAt: false, updatedAt: true } }
);

export const AdminAuditAlertStateModel: Model<AdminAuditAlertStateRecord> =
  (mongoose.models.AdminAuditAlertState as Model<AdminAuditAlertStateRecord> | undefined) ??
  model<AdminAuditAlertStateRecord>('AdminAuditAlertState', AdminAuditAlertStateSchema);

class AdminAuditAlertStateRepository implements IAdminAuditAlertStateRepository {
  constructor(private readonly stateModel: Model<AdminAuditAlertStateRecord>) {}

  async get(): Promise<AdminAuditAlertState | null> {
    const record = await this.stateModel.findById(STATE_ID).lean<AdminAuditAlertStateRecord>();
    if (!record) return null;
    return {
      cursor: { occurredAt: record.cursor.occurredAt, id: record.cursor.id },
      openBursts: record.openBursts.map(({ actorUserId, lastGrantAt }) => ({ actorUserId, lastGrantAt })),
      updatedAt: record.updatedAt,
    };
  }

  async save(state: Omit<AdminAuditAlertState, 'updatedAt'>): Promise<void> {
    await this.stateModel.updateOne(
      { _id: STATE_ID },
      { $set: { cursor: state.cursor, openBursts: state.openBursts } },
      { upsert: true }
    );
  }
}

export const adminAuditAlertStateRepository: IAdminAuditAlertStateRepository = new AdminAuditAlertStateRepository(
  AdminAuditAlertStateModel
);
