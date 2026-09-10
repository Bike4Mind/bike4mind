import { User } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import {
  IUserDocument,
  redactUserSecretsForSelf,
  publicUserProfileResponseSchema,
  type PublicUserProfile,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { Request } from 'express';

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
    // Self/admin-gated profile view. securityQuestions belong to the subject, so a self view
    // keeps them. userNotes are admin-authored notes ABOUT the subject and are gated on the
    // VIEWER: ProfileDataForm excludes them from its save payload (see its field allowlist
    // and ProfileDataForm.test.tsx), so a non-admin self view cannot blank them on save.
    return res.json(
      redactUserSecretsForSelf(user, {
        keep: ['securityQuestions'],
        ...(isAdmin && { keepAdminOnly: ['userNotes'] as const }),
      })
    );
  }

  return respond(res, publicUserProfileResponseSchema, toPublicProfile(user));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
