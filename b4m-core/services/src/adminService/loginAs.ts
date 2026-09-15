import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { NotFoundError, ForbiddenError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import * as mfaService from '@bike4mind/auth/mfaService';

const loginAsSchema = z.object({
  targetUserId: z.string(),
  mfaToken: z.string(),
});

type LoginAsParameters = z.infer<typeof loginAsSchema>;

type LoginAsAdapters = {
  db: {
    users: Pick<IUserRepository, 'findById' | 'findByIdWithMfaSecrets' | 'update' | 'atomicRecordMfaFailedAttempt'>;
  };
  notify: {
    send: (targetUser: IUserDocument) => Promise<void>;
  };
};

export const loginAs = async (adminUser: IUserDocument, parameters: LoginAsParameters, adapters: LoginAsAdapters) => {
  const { db, notify } = adapters;
  const { targetUserId, mfaToken } = secureParameters(parameters, loginAsSchema);

  if (!adminUser.isAdmin) {
    throw new ForbiddenError('Admin privileges required');
  }

  // MFA is required for loginAs - compromised admin account must not enable free impersonation
  if (!adminUser.mfa?.totpEnabled) {
    throw new ForbiddenError('MFA must be enabled to use loginAs');
  }

  // Get fresh admin user data (incl. select:false MFA secrets) for the MFA verification below;
  // req.user is a decoded JWT and never carries totpSecret/backupCodes.
  const freshAdmin = await db.users.findByIdWithMfaSecrets(adminUser.id);
  if (!freshAdmin) {
    throw new NotFoundError('Admin user not found');
  }

  // Re-verify admin status on fresh record - JWT may be stale if privileges were revoked
  if (!freshAdmin.isAdmin) {
    throw new ForbiddenError('Admin privileges required');
  }

  if (mfaService.isUserLockedOut(freshAdmin)) {
    const remainingMinutes = mfaService.getLockoutTimeRemaining(freshAdmin);
    throw new ForbiddenError(`MFA locked — too many failed attempts. Try again in ${remainingMinutes} minutes.`);
  }

  // Verify MFA token. verifyMFA clears any failed-attempt/lockout state as part of its
  // single secret-preserving write - a separate clear here (built from its not-+selected
  // return value) would wipe the admin's select:false MFA secrets.
  try {
    await mfaService.verifyMFA({ user: freshAdmin, token: mfaToken }, db.users);
  } catch {
    // Atomically record the failed attempt (mirrors mfa/verify.ts) - a read-modify-write
    // lets concurrent requests each read the same count and all write count+1, undercounting
    // failures and defeating the 3-strike lockout.
    const updatedAdmin = await db.users.atomicRecordMfaFailedAttempt(freshAdmin.id);

    if (updatedAdmin && mfaService.isUserLockedOut(updatedAdmin)) {
      throw new ForbiddenError('MFA locked — too many failed attempts');
    }
    throw new ForbiddenError('Invalid MFA token');
  }

  const targetUser = await db.users.findById(targetUserId);
  if (!targetUser) {
    throw new NotFoundError('Target user not found');
  }

  if (targetUser.isSystem) {
    throw new ForbiddenError('Cannot loginAs a system user');
  }

  await notify.send(targetUser);

  return targetUser;
};
