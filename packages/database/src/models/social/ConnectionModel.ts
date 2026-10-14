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

// Performance indexes. Built by the ensure-connection-indexes migration, not autoIndex.
// authExpiresAt: the realtime sweep's expiry scan. userId/sid/apiKeyId: realtimeConnectionRepository's
// revoke filters (ending a user's, a session's or an API key's connections).
ConnectionSchema.index({ authExpiresAt: 1 });
ConnectionSchema.index({ userId: 1 });
ConnectionSchema.index({ sid: 1 }, { partialFilterExpression: { sid: { $type: 'string' } } });
ConnectionSchema.index({ apiKeyId: 1 }, { partialFilterExpression: { apiKeyId: { $type: 'string' } } });

export const Connection =
  (mongoose.models.Connection as IConnectionModel) ??
  mongoose.model<IConnectionDocument, IConnectionModel>('Connection', ConnectionSchema);
export default Connection;
