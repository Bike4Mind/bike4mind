import { describe, it, expect } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { getMFAStatus } from './status';

describe('getMFAStatus', () => {
  it('reports a forced account as required and not disableable while the stage setting is off', () => {
    const user = { id: 'u1', mfa: null, mfaEnforcement: 'force' } as unknown as IUserDocument;
    expect(getMFAStatus({ user, enforceMFA: false })).toMatchObject({
      enabled: false,
      required: true,
      canDisable: false,
    });
  });

  it('reports an ordinary account as optional while the stage setting is off', () => {
    const user = { id: 'u1', mfa: null } as unknown as IUserDocument;
    expect(getMFAStatus({ user, enforceMFA: false })).toMatchObject({ required: false, canDisable: true });
  });
});
