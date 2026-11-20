import {
  IUserDocument,
  IUserRepository,
  assertCanActOnAdminTarget,
  hasAdminPermission,
  missingAdminPermissionMessage,
  type ResolveAdminRoles,
} from '@bike4mind/common';
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
    users: Pick<IUserRepository, 'findById' | 'findByIdWithMfaSecrets' | 'update' | 'atomicRecordMfaFailedAttempt'> &
      mfaService.MfaAttemptRepository;
  };
  notify: {
    send: (targetUser: IUserDocument) => Promise<void>;
  };
  /** Resolves the admin's role permissions on the fresh record below. */
  resolveAdminRoles?: ResolveAdminRoles;
};

export const loginAs = async (adminUser: IUserDocument, parameters: LoginAsParameters, adapters: LoginAsAdapters) => {
  const { db, notify } = adapters;
  const { targetUserId, mfaToken } = secureParameters(parameters, loginAsSchema);

  if (!hasAdminPermission(adminUser, 'users:impersonate')) {
    throw new ForbiddenError(missingAdminPermissionMessage('users:impersonate'));
  }

  // MFA is required for loginAs - compromised admin account must not enable free impersonation.
  // Authenticator app specifically: the code is verified below as a TOTP, so a passkey cannot serve.
  if (!mfaService.userHasTotpConfigured(adminUser)) {
    throw new ForbiddenError('An authenticator app must be enabled to use loginAs');
  }

  // Get fresh admin user data (incl. select:false MFA secrets) for the MFA verification below;
  // req.user is a decoded JWT and never carries totpSecret/backupCodes.
  const storedAdmin = await db.users.findByIdWithMfaSecrets(adminUser.id);
  if (!storedAdmin) {
    throw new NotFoundError('Admin user not found');
  }
  const freshAdmin = adapters.resolveAdminRoles ? await adapters.resolveAdminRoles(storedAdmin) : storedAdmin;

  // Re-verify on the fresh record - JWT may be stale if privileges were revoked
  if (!hasAdminPermission(freshAdmin, 'users:impersonate')) {
    throw new ForbiddenError(missingAdminPermissionMessage('users:impersonate'));
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
  } catch (error) {
    // A code checked by verifyMFA was counted before it was compared; anything else is counted now.
    const updatedAdmin = await mfaService.recordFailedMfaAttempt(error, freshAdmin.id, db.users);

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

  if (targetUser.deletion) {
    throw new ForbiddenError('Cannot loginAs an account that is scheduled for deletion');
  }

  // Must stay before any approval request: a delegate never stores a pending impersonation of an admin.
  assertCanActOnAdminTarget(freshAdmin, targetUser, 'impersonate');

  await notify.send(targetUser);

  return targetUser;
};
