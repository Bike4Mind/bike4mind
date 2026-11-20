import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { regenerateBackupCodes } from './regenerateBackupCodes';
import { hashBackupCode } from './utils';

const userWith = (totpSecret: string) =>
  ({
    id: 'user-1',
    mfa: { totpSecret, totpEnabled: true, backupCodes: ['old'], setupAt: new Date() },
  }) as unknown as IUserDocument;

describe('regenerateBackupCodes', () => {
  it('stores hashed codes alongside the secret and returns the plaintext codes once', async () => {
    const update = vi.fn(async (data: Partial<IUserDocument>) => data as IUserDocument);
    const result = await regenerateBackupCodes({ user: userWith('JBSWY3DPEHPK3PXP') }, { update });

    expect(result.backupCodes).toHaveLength(10);
    const written = update.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(written).not.toHaveProperty('mfa');
    const stored = written['mfa.backupCodes'] as string[];
    expect(stored).toEqual(result.backupCodes.map(hashBackupCode));
    expect(stored).not.toContain(result.backupCodes[0]);
  });

  it('works for a passkey-only user, writing the dotted backup-code field', async () => {
    const update = vi.fn(async (data: Partial<IUserDocument>) => data as IUserDocument);
    const user = {
      id: 'user-1',
      mfa: { totpEnabled: false, passkeyEnabled: true, backupCodes: ['old'], setupAt: new Date() },
    } as unknown as IUserDocument;

    const result = await regenerateBackupCodes({ user }, { update });

    expect(result.backupCodes).toHaveLength(10);
    const written = update.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(written).toMatchObject({ id: 'user-1' });
    expect(written['mfa.backupCodes']).toEqual(result.backupCodes.map(hashBackupCode));
    expect(written).not.toHaveProperty('mfa');
  });

  it('refuses a user with no MFA configured', async () => {
    const update = vi.fn();
    const user = { id: 'user-1', mfa: { totpEnabled: false } } as unknown as IUserDocument;
    await expect(regenerateBackupCodes({ user }, { update })).rejects.toThrow(/not enabled/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when the stored secret could not be decrypted, instead of showing codes it never saved', async () => {
    const update = vi.fn();
    await expect(regenerateBackupCodes({ user: userWith('') }, { update })).rejects.toThrow(/unavailable/);
    expect(update).not.toHaveBeenCalled();
  });
});
