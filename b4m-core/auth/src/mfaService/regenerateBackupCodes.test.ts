import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { regenerateBackupCodes } from './regenerateBackupCodes';

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
    const written = update.mock.calls[0][0];
    expect(written.mfa?.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(written.mfa?.backupCodes).toHaveLength(10);
    expect(written.mfa?.backupCodes).not.toContain(result.backupCodes[0]);
  });

  it('refuses when the stored secret could not be decrypted, instead of showing codes it never saved', async () => {
    const update = vi.fn();
    await expect(regenerateBackupCodes({ user: userWith('') }, { update })).rejects.toThrow(/unavailable/);
    expect(update).not.toHaveBeenCalled();
  });
});
