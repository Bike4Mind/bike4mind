import mongoose, { Schema, Model, model, Types } from 'mongoose';
import type { ActorKind } from '@bike4mind/hearth';

/**
 * A Hearth actor: any participant in the event log - human, agent, gateway,
 * device, or system. Actors belong to a user account (the billing/auth
 * principal); spawning many agent actors under one user is free by design.
 */
export interface IHearthActorDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: ActorKind;
  displayName: string;
  /** Capability strings, e.g. 'cli.exec:<device>', 'gate.approve'. */
  capabilities: string[];
  reachability: Array<{ transport: string; address: string; priority: number }>;
  /** Spawning actor for sub-agents; preserves audit lineage. */
  parentActorId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const HearthActorSchema = new Schema<IHearthActorDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: {
      type: String,
      required: true,
      enum: ['human', 'agent', 'gateway', 'device', 'system'],
    },
    displayName: { type: String, required: true, maxlength: 200 },
    capabilities: { type: [String], default: [] },
    reachability: {
      type: [
        new Schema(
          {
            transport: { type: String, required: true },
            address: { type: String, required: true },
            priority: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    parentActorId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// Identity for find-or-create: one actor per (user, kind, displayName).
HearthActorSchema.index({ userId: 1, kind: 1, displayName: 1 }, { unique: true, name: 'hearth_actor_identity' });

export interface IHearthActorModel extends Model<IHearthActorDoc> {}

export const HearthActor: IHearthActorModel =
  mongoose.models.HearthActor ?? model<IHearthActorDoc>('HearthActor', HearthActorSchema);

export default HearthActor;
