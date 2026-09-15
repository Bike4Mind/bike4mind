import mongoose, { Schema, Model, model, Types } from 'mongoose';

/**
 * A Hearth channel: an ordered stream of events. `nextSeq` is the per-channel
 * monotonic sequence counter; it is only ever advanced via an atomic $inc in
 * MongoHearthStore.appendEvent, which is what makes seq allocation safe under
 * concurrent writers.
 */
export interface IHearthChannelDoc {
  _id: Types.ObjectId;
  name: string;
  /** Owning user; phase 3 scopes channel access to the owner. */
  userId: Types.ObjectId;
  /** Set when the channel mirrors an external network via a gateway actor. */
  gatewayActorId?: Types.ObjectId;
  /** Last allocated event seq (0 = empty channel). */
  nextSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

const HearthChannelSchema = new Schema<IHearthChannelDoc>(
  {
    name: { type: String, required: true, maxlength: 200 },
    userId: { type: Schema.Types.ObjectId, required: true },
    gatewayActorId: { type: Schema.Types.ObjectId },
    nextSeq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

HearthChannelSchema.index({ userId: 1, name: 1 }, { unique: true, name: 'hearth_channel_user_name' });

export interface IHearthChannelModel extends Model<IHearthChannelDoc> {}

export const HearthChannel: IHearthChannelModel =
  mongoose.models.HearthChannel ?? model<IHearthChannelDoc>('HearthChannel', HearthChannelSchema);

export default HearthChannel;
