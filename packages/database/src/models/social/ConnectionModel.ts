import { IConnection, IConnectionDocument } from '@bike4mind/common';
import mongoose, { HydratedDocument } from 'mongoose';

interface IConnectionModel extends mongoose.Model<IConnectionDocument> {
  findByUserId(userId: string): Promise<HydratedDocument<IConnection>[]>;
  deleteByConnectionId(connectionId: string): Promise<void>;
}

const connectionFields = {
  connectionId: { type: String, required: true, unique: true },
  userId: { type: String, ref: 'User', required: true },
  source: { type: String, enum: ['cli', 'web'] },
  scopes: { type: [String] },
  sid: { type: String },
  tokenVersion: { type: Number },
  authExpiresAt: { type: Date },
  apiKeyId: { type: String },
  endedAt: { type: Date },
  reauthAt: { type: Date },
} as const;

export const ConnectionSchema = new mongoose.Schema<IConnectionDocument, IConnectionModel>(connectionFields, {
  statics: {
    findByUserId: function (userId: string) {
      return this.find({ userId });
    },
    deleteByConnectionId: function (connectionId: string) {
      return this.deleteOne({ connectionId });
    },
  },
  timestamps: true,
  toJSON: {
    virtuals: true,
  },
  toObject: {
    virtuals: true,
  },
});

declare module 'mongoose' {
  // Declaration merging needs mongoose's exact type parameters, used or not.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface QueryOptions<DocType = unknown> {
    /** Connection reads: include ended rows, which are otherwise hidden (see excludeEndedConnections). */
    includeEnded?: boolean;
  }
}

// A row with endedAt set is an ended connection awaiting its socket close (see
// realtimeConnectionRepository), not a live one. Reads that mean "live connections" therefore
// skip it here, once, rather than in every handler. The sweep's ended-row scan opts out with
// `.setOptions({ includeEnded: true })`; a filter that merely names endedAt does not.
// Writes (updateOne/deleteOne) are not filtered.
function excludeEndedConnections(this: mongoose.Query<unknown, unknown>) {
  if (this.getOptions().includeEnded) return;
  this.where({ endedAt: { $exists: false } });
}
ConnectionSchema.pre(['find', 'findOne', 'countDocuments', 'distinct'], excludeEndedConnections);

// Performance indexes. Built by the ensure-connection-indexes migration, not autoIndex.
// userId/sid/apiKeyId: realtimeConnectionRepository's revoke filters (ending a user's, a
// session's or an API key's connections). Plain, not partial: a partial index is only usable when
// the query repeats its filter. The realtime sweep pages by _id and needs no index of its own.
ConnectionSchema.index({ userId: 1 });
ConnectionSchema.index({ sid: 1 });
ConnectionSchema.index({ apiKeyId: 1 });

export const Connection =
  (mongoose.models.Connection as IConnectionModel) ??
  mongoose.model<IConnectionDocument, IConnectionModel>('Connection', ConnectionSchema);
export default Connection;
