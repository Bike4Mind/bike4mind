import { User } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument } from '@bike4mind/common';
import { Request } from 'express';

/**
 * Fields safe to expose to any authenticated user about another user's profile.
 * Deliberately excludes: email, isAdmin, financial data, OAuth tokens,
 * security questions, admin notes, login records, and Slack credentials.
 */
export interface PublicUserProfile {
  id: string;
  username: string;
  name: string;
  photoUrl: string | null;
  level: string;
  role: string | null;
  team: string | null;
  lastActiveAt?: Date;
  isOnline: boolean;
}

function toPublicProfile(user: IUserDocument): PublicUserProfile {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    photoUrl: user.photoUrl,
    level: user.level,
    role: user.role,
    team: user.team,
    lastActiveAt: user.lastActiveAt,
    isOnline: user.isOnline ?? false,
  };
}

const handler = baseApi().get<Request<{}, unknown, unknown, { id: string }>>(async (req, res) => {
  const userId = req.query.id;

  const user = await User.findById(userId).populate('organizationId').select('-password -counters');
  // Return 404 for missing users regardless of requester privilege.
  // Do NOT change to 403 - that would confirm the user exists and enable
  // user enumeration by authenticated callers probing arbitrary IDs.
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isSelf = req.user.id === userId;
  const isAdmin = req.user.isAdmin;

  if (isSelf || isAdmin) {
    return res.json(user);
  }

  return res.json(toPublicProfile(user));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
