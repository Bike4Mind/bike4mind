import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { disableMFA } from './disable';

const userWith = (mfa: unknown) => ({ id: 'user-1', mfa }) as unknown as IUserDocument;
const makeUpdate = () => vi.fn(async (u: unknown) => u as IUserDocument);

describe('disableMFA', () => {
  it.each([
    ['an authenticator app only', { totpEnabled: true }],
    ['a passkey only', { totpEnabled: false, passkeyEnabled: true }],
    ['both factors', { totpEnabled: true, passkeyEnabled: true }],
  ])('clears MFA for a user with %s', async (_label, mfa) => {
    const update = makeUpdate();
    await expect(disableMFA({ user: userWith(mfa), enforceMFA: false }, { update })).resolves.toMatchObject({
      success: true,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', mfa: null }));
  });

  it.each([
    ['no mfa', null],
    ['a pending app setup', { totpEnabled: false }],
  ])('refuses a user with %s', async (_label, mfa) => {
    const update = makeUpdate();
    await expect(disableMFA({ user: userWith(mfa), enforceMFA: false }, { update })).rejects.toThrow(
      'MFA is not enabled for this user.'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a passkey-only user when MFA is enforced', async () => {
    const update = makeUpdate();
    await expect(
      disableMFA({ user: userWith({ totpEnabled: false, passkeyEnabled: true }), enforceMFA: true }, { update })
    ).rejects.toThrow(/enforcement/);
    expect(update).not.toHaveBeenCalled();
  });

  it('throws when the write returns nothing', async () => {
    const update = vi.fn(async () => null);
    await expect(disableMFA({ user: userWith({ totpEnabled: true }), enforceMFA: false }, { update })).rejects.toThrow(
      'Failed to disable MFA.'
    );
  });
});
