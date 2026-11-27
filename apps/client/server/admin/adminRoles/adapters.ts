import { User, adminRoleRepository, withTransaction } from '@bike4mind/database';
import { requestAuditWriter, type AuditRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { requireStepUp } from '@server/auth/stepUp';
import { Types } from 'mongoose';
import type { AdminRolesDeps } from './adminRoles';

/** Shared by both admin role routes: one per-admin budget for reads and writes together. */
export const ADMIN_ROLES_RATE_LIMIT = { limit: 60, windowMs: 60_000, bucket: 'admin-roles' };

// Ids reach here already checked as ObjectId hex by the route or the repository.
const memberCounts = async (roleIds: readonly string[]): Promise<Map<string, number>> => {
  if (roleIds.length === 0) return new Map();
  const ids = roleIds.map(id => new Types.ObjectId(id));
  const rows = await User.aggregate<{ _id: Types.ObjectId; members: number }>([
    { $match: { adminRoleIds: { $in: ids } } },
    { $unwind: '$adminRoleIds' },
    { $match: { adminRoleIds: { $in: ids } } },
    { $group: { _id: '$adminRoleIds', members: { $sum: 1 } } },
  ]);
  return new Map(rows.map(row => [String(row._id), row.members]));
};

const removeFromMembers = async (roleId: string): Promise<number> => {
  const id = new Types.ObjectId(roleId);
  const result = await User.updateMany({ adminRoleIds: id }, { $pull: { adminRoleIds: id } });
  return result.modifiedCount;
};

export const adminRolesDeps = (req: AuditRequest): AdminRolesDeps => ({
  roles: adminRoleRepository,
  memberCounts,
  removeFromMembers,
  audit: requestAuditWriter(req),
  requireStepUp: () => requireStepUp(req),
  transaction: work => withTransaction(work),
});
