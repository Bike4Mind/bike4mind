import { Project, User } from '@bike4mind/database';
import { isObjectIdOrHexString } from 'mongoose';

export async function hasVerifiedProjectCollaborator(userId: string): Promise<boolean> {
  // Membership is written when an invitation is accepted, or access is granted directly.
  const members = await Project.aggregate<{ _id: string }>([
    { $match: { userId, deletedAt: null } },
    { $unwind: '$users' },
    { $match: { 'users.permissions': 'read' } },
    { $group: { _id: '$users.userId' } },
  ]);
  const others = members
    .map(member => member._id)
    .filter(id => typeof id === 'string' && id !== userId && isObjectIdOrHexString(id));
  return others.length > 0 && !!(await User.exists({ _id: { $in: others }, emailVerified: true, deletedAt: null }));
}
