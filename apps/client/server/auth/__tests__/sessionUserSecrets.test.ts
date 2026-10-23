import { describe, expect, it } from 'vitest';
import { secretUserFields } from './sessionUserSecrets';

describe('secretUserFields', () => {
  it('isolates mutable arrays, subdocuments, and dates between calls', () => {
    const first = secretUserFields();
    const second = secretUserFields();
    const pristine = structuredClone(second);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);

    first.loginRecords.unshift({ ip: 'new-login' });
    first.loginRecords[1].ip = 'changed-login';
    first.mfa.backupCodes.push('new-backup-code');
    first.authProviders[0].accessToken = 'changed-token';
    first.googleDrive.accessToken = 'changed-token';
    first.resetPasswordSentAt.setUTCFullYear(2000);

    expect(second).toEqual(pristine);
    expect(secretUserFields()).toEqual(pristine);
  });
});
