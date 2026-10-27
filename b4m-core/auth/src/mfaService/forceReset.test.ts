import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError, type IUserDocument } from '@bike4mind/common';
import { forceResetMFA } from './forceReset';

const user = (overrides: Partial<IUserDocument>) =>
  ({
    id: 'target-1',
    mfa: { totpSecret: 'secret', totpEnabled: true, backupCodes: [], setupAt: new Date() },
    ...overrides,
  }) as unknown as IUserDocument;

const DELEGATE = user({ id: 'delegate-1', isAdmin: false, adminPermissions: ['settings:manage'] });
const FULL_ADMIN = user({ id: 'admin-1', isAdmin: true });

const repositoryFor = (target: IUserDocument) => ({
  findById: vi.fn(async () => target),
  update: vi.fn(async (data: Partial<IUserDocument>) => ({ ...target, ...data }) as IUserDocument),
});

describe('forceResetMFA', () => {
  it('refuses a delegated settings manager resetting the MFA of a full admin, before any write', async () => {
    const repository = repositoryFor(user({ isAdmin: true }));
    const reset = forceResetMFA({ targetUserId: 'target-1', adminUser: DELEGATE }, repository);

    await expect(reset).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reset).rejects.toThrow('Only full administrators can reset MFA of users with admin access');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses a delegate resetting another delegated operator', async () => {
    const repository = repositoryFor(user({ adminPermissions: ['support:read'] }));
    await expect(forceResetMFA({ targetUserId: 'target-1', adminUser: DELEGATE }, repository)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('lets a delegated settings manager reset a regular user', async () => {
    const repository = repositoryFor(user({}));
    const result = await forceResetMFA({ targetUserId: 'target-1', adminUser: DELEGATE }, repository);

    expect(result.success).toBe(true);
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'target-1', mfa: null }));
  });

  it('lets a full admin reset another admin', async () => {
    const repository = repositoryFor(user({ isAdmin: true }));
    await expect(forceResetMFA({ targetUserId: 'target-1', adminUser: FULL_ADMIN }, repository)).resolves.toMatchObject(
      { success: true }
    );
  });
});
