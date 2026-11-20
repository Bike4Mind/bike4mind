import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { forceResetMFA } from './forceReset';

const target = { id: 'target1', mfa: { totpEnabled: true } } as unknown as IUserDocument;
const repo = (found: object = target) => ({
  findById: vi.fn().mockResolvedValue(found),
  update: vi.fn().mockResolvedValue({ ...target, mfa: null }),
});
const actor = (fields: Record<string, unknown>) => ({ id: 'actor1', ...fields }) as unknown as IUserDocument;

describe('forceResetMFA', () => {
  it.each([
    ['a full admin', { isAdmin: true }],
    ['a users:moderate delegate', { isAdmin: false, adminPermissions: ['users:moderate'] }],
  ])('resets MFA for %s', async (_label, fields) => {
    const users = repo();
    await expect(forceResetMFA({ targetUserId: 'target1', adminUser: actor(fields) }, users)).resolves.toMatchObject({
      success: true,
    });
    expect(users.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'target1', mfa: null }));
  });

  it.each([
    ['a delegate without users:moderate', { isAdmin: false, adminPermissions: ['support:read'] }],
    ['a non-admin', { isAdmin: false }],
  ])('refuses %s', async (_label, fields) => {
    const users = repo();
    await expect(forceResetMFA({ targetUserId: 'target1', adminUser: actor(fields) }, users)).rejects.toThrow(
      'Only administrators can force reset MFA.'
    );
    expect(users.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a full admin', { isAdmin: true }],
    ['a delegated admin', { isAdmin: false, adminPermissions: ['support:read'] }],
  ])('refuses a delegate resetting MFA for %s', async (_label, fields) => {
    const users = repo({ ...target, ...fields });
    const delegate = actor({ isAdmin: false, adminPermissions: ['users:moderate'] });
    await expect(forceResetMFA({ targetUserId: 'target1', adminUser: delegate }, users)).rejects.toThrow(
      'Only full administrators can reset MFA for users with admin access'
    );
    expect(users.update).not.toHaveBeenCalled();
  });

  it.each([
    ['an authenticator app only', { totpEnabled: true }],
    ['a passkey only', { totpEnabled: false, passkeyEnabled: true }],
    ['both factors', { totpEnabled: true, passkeyEnabled: true }],
  ])('resets MFA for a target with %s', async (_label, mfa) => {
    const users = repo({ ...target, mfa });
    await expect(
      forceResetMFA({ targetUserId: 'target1', adminUser: actor({ isAdmin: true }) }, users)
    ).resolves.toMatchObject({ success: true });
    expect(users.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'target1', mfa: null }));
  });

  it.each([
    ['no mfa', null],
    ['a pending app setup', { totpEnabled: false }],
  ])('refuses a target with %s', async (_label, mfa) => {
    const users = repo({ ...target, mfa } as object);
    await expect(
      forceResetMFA({ targetUserId: 'target1', adminUser: actor({ isAdmin: true }) }, users)
    ).rejects.toThrow('Target user does not have MFA enabled.');
    expect(users.update).not.toHaveBeenCalled();
  });

  it('lets a full admin reset MFA for another admin', async () => {
    const users = repo({ ...target, isAdmin: true });
    await forceResetMFA({ targetUserId: 'target1', adminUser: actor({ isAdmin: true }) }, users);
    expect(users.update).toHaveBeenCalledTimes(1);
  });
});
