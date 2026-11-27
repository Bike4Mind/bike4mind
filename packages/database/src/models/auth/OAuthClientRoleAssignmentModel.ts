import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { OAuthClientModel } from './OAuthClientModel';
import { User } from './UserModel';

/**
 * One role a user holds on one OAuth client (per-app roles: an app only ever sees its own). `clientId`
 * is the OAuth client_id, so each stage of an app, having its own client_id, is assigned separately.
 * Removing an assignment deletes the row; the roles themselves are defined on the client
 * (OAuthClientModel `roles`), and oauthClientAdmin.ts keeps the two consistent.
 */
export interface IOAuthClientRoleAssignmentDocument extends IMongoDocument {
  userId: string;
  clientId: string;
  role: string;
  /** The admin who assigned it. */
  assignedBy: string;
  assignedAt: Date;
}

export interface IOAuthClientRoleAssignmentRepository extends IBaseRepository<IOAuthClientRoleAssignmentDocument> {
  /** Idempotent: an existing (user, client, role) row is returned unchanged. */
  assign(
    params: {
      userId: string;
      clientId: string;
      role: string;
      assignedBy: string;
    },
    session?: mongoose.mongo.ClientSession
  ): Promise<{ assignment: IOAuthClientRoleAssignmentDocument; created: boolean }>;
  /** True when a row was deleted. */
  unassign(userId: string, clientId: string, role: string, session?: mongoose.mongo.ClientSession): Promise<boolean>;
  /** Per role: how many hold it and the earliest `limit` assignments. */
  listHoldersByClient(
    clientId: string,
    roles: readonly string[],
    limit: number
  ): Promise<Array<{ role: string; count: number; rows: IOAuthClientRoleAssignmentDocument[] }>>;
  listByUser(userId: string): Promise<IOAuthClientRoleAssignmentDocument[]>;
  listUserIdsForRole(clientId: string, role: string, session?: mongoose.mongo.ClientSession): Promise<string[]>;
  /** Every assignment on the client, or only those of `role`. */
  deleteAllForClient(clientId: string, role?: string, session?: mongoose.mongo.ClientSession): Promise<number>;
  deleteAllForUser(userId: string): Promise<number>;
  /**
   * The role keys a client may read for a user: [] when the user is deleted, banned, suspended or in
   * a payment dispute (the block reasons of accountBlockReasons in b4m-core/services), and only roles
   * the client still defines. The read for userinfo / id_token role claims.
   */
  listRolesForUserAndClient(userId: string, clientId: string): Promise<string[]>;
}

type IOAuthClientRoleAssignmentModel = Model<IOAuthClientRoleAssignmentDocument>;

const OAuthClientRoleAssignmentSchema = new Schema<IOAuthClientRoleAssignmentDocument>({
  userId: { type: String, required: true },
  clientId: { type: String, required: true },
  role: { type: String, required: true },
  assignedBy: { type: String, required: true },
  assignedAt: { type: Date, required: true, default: () => new Date() },
});

OAuthClientRoleAssignmentSchema.index({ userId: 1, clientId: 1, role: 1 }, { unique: true });
OAuthClientRoleAssignmentSchema.index({ clientId: 1, role: 1, assignedAt: 1 });

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

// Match existing hex spellings, while new assignments store the canonical account ID.
const roleUserIdentity = (userId: string) => {
  if (!mongoose.isObjectIdOrHexString(userId)) return { canonical: userId, match: userId };
  const canonical = new mongoose.Types.ObjectId(userId).toHexString();
  return { canonical, match: new RegExp(`^${canonical}$`, 'i') };
};

class OAuthClientRoleAssignmentRepository
  extends BaseRepository<IOAuthClientRoleAssignmentDocument>
  implements IOAuthClientRoleAssignmentRepository
{
  constructor(m: IOAuthClientRoleAssignmentModel) {
    super(m);
  }

  async assign(
    params: { userId: string; clientId: string; role: string; assignedBy: string },
    session?: mongoose.mongo.ClientSession
  ) {
    const user = roleUserIdentity(params.userId);
    const filter = { userId: user.match, clientId: params.clientId, role: params.role };
    const upsert = () =>
      this.model
        .findOneAndUpdate(
          filter,
          { $setOnInsert: { userId: user.canonical, assignedBy: params.assignedBy, assignedAt: new Date() } },
          { upsert: true, new: true, runValidators: true, includeResultMetadata: true, session }
        )
        .exec();
    let result;
    try {
      result = await upsert();
    } catch (error) {
      // Two concurrent first assigns race the unique index; the loser finds the winner's row.
      if (session || !isDuplicateKey(error)) throw error;
      result = await upsert();
    }
    return {
      assignment: result.value as IOAuthClientRoleAssignmentDocument,
      created: result.lastErrorObject?.upserted !== undefined,
    };
  }

  async unassign(userId: string, clientId: string, role: string, session?: mongoose.mongo.ClientSession) {
    const result = await this.model
      .deleteMany({ userId: roleUserIdentity(userId).match, clientId, role }, { session })
      .exec();
    return result.deletedCount > 0;
  }

  listHoldersByClient(clientId: string, roles: readonly string[], limit: number) {
    return Promise.all(
      roles.map(async role => ({
        role,
        count: await this.model.countDocuments({ clientId, role }).exec(),
        rows: await this.model.find({ clientId, role }).sort({ assignedAt: 1 }).limit(limit).exec(),
      }))
    );
  }

  async listUserIdsForRole(clientId: string, role: string, session?: mongoose.mongo.ClientSession) {
    const rows = await this.model
      .find({ clientId, role })
      .select('userId')
      .session(session ?? null)
      .lean()
      .exec();
    return rows.map(r => r.userId);
  }

  listByUser(userId: string) {
    return this.model
      .find({ userId: roleUserIdentity(userId).match })
      .sort({ clientId: 1, role: 1 })
      .exec();
  }

  async deleteAllForClient(clientId: string, role?: string, session?: mongoose.mongo.ClientSession) {
    const result = await this.model
      .deleteMany({ clientId, ...(role === undefined ? {} : { role }) }, { session })
      .exec();
    return result.deletedCount;
  }

  async deleteAllForUser(userId: string) {
    const result = await this.model.deleteMany({ userId: roleUserIdentity(userId).match }).exec();
    return result.deletedCount;
  }

  async listRolesForUserAndClient(userId: string, clientId: string) {
    if (!mongoose.isValidObjectId(userId)) return [];
    const usable = await User.exists({
      _id: userId,
      deletedAt: { $exists: false },
      isBanned: { $ne: true },
      disputePending: { $ne: true },
      'moderation.status': { $ne: 'suspended' },
    });
    if (!usable) return [];
    const client = await OAuthClientModel.findOne({ clientId }).select('roles').lean().exec();
    const defined = new Set((client?.roles ?? []).map(r => r.key));
    const rows = await this.model
      .find({ userId: roleUserIdentity(userId).match, clientId })
      .select('role')
      .sort({ role: 1 })
      .lean()
      .exec();
    return [...new Set(rows.map(r => r.role).filter(role => defined.has(role)))];
  }
}

export const OAuthClientRoleAssignmentModel =
  (mongoose.models['OAuthClientRoleAssignment'] as IOAuthClientRoleAssignmentModel) ??
  model<IOAuthClientRoleAssignmentDocument>('OAuthClientRoleAssignment', OAuthClientRoleAssignmentSchema);

export const oauthClientRoleAssignmentRepository = new OAuthClientRoleAssignmentRepository(
  OAuthClientRoleAssignmentModel
);
