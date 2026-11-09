import mongoose, { Model, model, Schema, Types } from 'mongoose';

export const ADMIN_GATE_RESERVATION_KINDS = ['users', 'credits'] as const;
export type AdminGateReservationKind = (typeof ADMIN_GATE_RESERVATION_KINDS)[number];

type AdminGateReservationDocumentShape = {
  _id: Types.ObjectId;
  actorUserId: string;
  kind: AdminGateReservationKind;
  amount: number;
  expiresAt: Date;
};

// What an admin's in-flight gated action will add to the approval-threshold window, held until its audit rows land.
const AdminGateReservationSchema = new Schema<AdminGateReservationDocumentShape>(
  {
    actorUserId: { type: String, required: true },
    kind: { type: String, enum: ADMIN_GATE_RESERVATION_KINDS, required: true },
    amount: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'admingatereservations', versionKey: false }
);

AdminGateReservationSchema.index({ actorUserId: 1, kind: 1, expiresAt: 1 });
AdminGateReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminGateReservationModel: Model<AdminGateReservationDocumentShape> =
  (mongoose.models.AdminGateReservation as Model<AdminGateReservationDocumentShape> | undefined) ??
  model<AdminGateReservationDocumentShape>('AdminGateReservation', AdminGateReservationSchema);

export const adminGateReservationRepository = {
  async reserve(actorUserId: string, kind: AdminGateReservationKind, amount: number, expiresAt: Date): Promise<string> {
    const created = await AdminGateReservationModel.create({ actorUserId, kind, amount, expiresAt });
    return created._id.toHexString();
  },

  /** Sum of the unexpired reservations, including the caller's own. */
  async sumReserved(actorUserId: string, kind: AdminGateReservationKind, now: Date): Promise<number> {
    const [total] = await AdminGateReservationModel.aggregate<{ amount: number }>([
      { $match: { actorUserId, kind, expiresAt: { $gt: now } } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]);
    return total?.amount ?? 0;
  },

  async release(id: string): Promise<void> {
    await AdminGateReservationModel.deleteOne({ _id: new Types.ObjectId(id) });
  },
};
