import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards atomicEnablePasskeyMfa, the one write that makes a passkey a user's first factor. It must
 * work on a user whose `mfa` is null (where a dotted $set cannot create the field and a whole-`mfa`
 * $set is dropped by the secret-less guard), and must issue backup codes at most once.
 */
describe('atomicEnablePasskeyMfa', () => {
  setupMongoTest();

  let userId: string;
  const readMfa = async () => (await userRepository.findByIdWithMfaSecrets(userId))!.mfa;

  beforeEach(async () => {
    await User.deleteMany({});
    const user = await User.create({ username: 'passkey-user', email: 'passkey@example.com', name: 'Passkey User' });
    userId = user.id;
  });

  it('turns MFA on for a user with no mfa subdocument and stores the hashed codes', async () => {
    expect(await readMfa()).toBeNull();

    const enabled = await userRepository.atomicEnablePasskeyMfa(userId, ['h1', 'h2']);

    expect(enabled?.mfa?.passkeyEnabled).toBe(true);
    const mfa = (await readMfa())!;
    expect(mfa.passkeyEnabled).toBe(true);
    expect(mfa.totpEnabled).toBe(false);
    expect(mfa.backupCodes).toEqual(['h1', 'h2']);
    expect(mfa.totpSecret).toBeUndefined();
    expect(mfa.setupAt).toBeInstanceOf(Date);
  });

  it('discards an unconfirmed app setup', async () => {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          mfa: { totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: false, backupCodes: ['old'], setupAt: new Date() },
        },
      }
    );

    await userRepository.atomicEnablePasskeyMfa(userId, ['h1']);

    const mfa = (await readMfa())!;
    expect(mfa.passkeyEnabled).toBe(true);
    expect(mfa.totpSecret).toBeUndefined();
    expect(mfa.backupCodes).toEqual(['h1']);
  });

  it('refuses once a factor is on, so codes are issued only once', async () => {
    const results = await Promise.all([
      userRepository.atomicEnablePasskeyMfa(userId, ['a']),
      userRepository.atomicEnablePasskeyMfa(userId, ['b']),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await userRepository.atomicEnablePasskeyMfa(userId, ['c'])).toBeNull();
  });

  it('leaves an authenticator-app user untouched', async () => {
    await User.updateOne(
      { _id: userId },
      {
        $set: { mfa: { totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: true, backupCodes: ['app'], setupAt: new Date() } },
      }
    );

    expect(await userRepository.atomicEnablePasskeyMfa(userId, ['h1'])).toBeNull();
    expect((await readMfa())!.backupCodes).toEqual(['app']);
  });
});
