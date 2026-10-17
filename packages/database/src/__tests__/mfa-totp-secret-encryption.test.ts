import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { configureSecretsAtRest, encryptSecret, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { User, userRepository } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards that `mfa.totpSecret` is never stored in plaintext: every write form the MFA code and
 * snapshot writers use lands as ciphertext, findByIdWithMfaSecrets hands back the plaintext, and
 * rows enrolled before encryption (plaintext) keep verifying until the backfill reaches them.
 */
describe('mfa.totpSecret encryption at rest', () => {
  setupMongoTest();

  const KEY = generateEncryptionKey();
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  const OTHER_SECRET = 'KRSXG5CTMVRXEZLU';
  let userId: string;

  // Bypasses the model (and its hooks) to see exactly what is on disk.
  const readStoredSecret = async (): Promise<string | undefined> => {
    const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    return (raw?.mfa as { totpSecret?: string } | undefined)?.totpSecret;
  };
  const expectStoredEncrypted = async (plaintext: string) => {
    const stored = await readStoredSecret();
    expect(stored).not.toBe(plaintext);
    expect(isEncrypted(stored ?? '')).toBe(true);
    expect((await userRepository.findByIdWithMfaSecrets(userId))!.mfa!.totpSecret).toBe(plaintext);
  };
  const mfaWith = (totpSecret: string) => ({
    totpSecret,
    totpEnabled: false,
    backupCodes: ['h1'],
    setupAt: new Date(),
  });

  beforeAll(() => {
    configureSecretsAtRest(KEY);
  });

  afterAll(() => {
    configureSecretsAtRest(undefined);
  });

  beforeEach(async () => {
    await User.deleteMany({});
    const user = await User.create({
      username: 'totp-enc-user',
      email: 'totp-enc@example.com',
      name: 'TOTP Encryption User',
    });
    userId = user.id;
  });

  describe('every write path stores ciphertext', () => {
    it('User.create / save', async () => {
      await User.deleteMany({});
      const user = await User.create({
        username: 'totp-create',
        email: 'totp-create@example.com',
        name: 'TOTP Create',
        mfa: mfaWith(TOTP_SECRET),
      });
      userId = user.id;
      await expectStoredEncrypted(TOTP_SECRET);
    });

    it('repository update with a whole mfa subdocument (setupMFA)', async () => {
      await userRepository.update({ id: userId, mfa: mfaWith(TOTP_SECRET) });
      await expectStoredEncrypted(TOTP_SECRET);
    });

    it('direct model updates: top-level mfa, $set mfa, and dotted $set', async () => {
      await User.updateOne({ _id: userId }, { mfa: mfaWith(TOTP_SECRET) });
      await expectStoredEncrypted(TOTP_SECRET);

      await User.findOneAndUpdate({ _id: userId }, { $set: { mfa: mfaWith(OTHER_SECRET) } });
      await expectStoredEncrypted(OTHER_SECRET);

      await User.updateMany({ _id: userId }, { $set: { 'mfa.totpSecret': TOTP_SECRET } });
      await expectStoredEncrypted(TOTP_SECRET);
    });

    it('a snapshot writer re-encrypts the decrypted secret it read (passkey, verify)', async () => {
      await userRepository.update({ id: userId, mfa: mfaWith(TOTP_SECRET) });
      const firstCiphertext = await readStoredSecret();

      const snapshot = await userRepository.findByIdWithMfaSecrets(userId);
      expect(snapshot!.mfa!.totpSecret).toBe(TOTP_SECRET);
      await userRepository.update({ id: userId, mfa: { ...snapshot!.mfa!, failedAttempts: 0 } });

      await expectStoredEncrypted(TOTP_SECRET);
      // Fresh IV on every write, so plaintext equality can never be inferred from the stored value.
      expect(await readStoredSecret()).not.toBe(firstCiphertext);
    });

    it('does not double-encrypt a value that is already ciphertext', async () => {
      const ciphertext = encryptSecret(TOTP_SECRET, KEY);
      await userRepository.update({ id: userId, mfa: mfaWith(OTHER_SECRET) });
      await User.updateOne({ _id: userId }, { $set: { 'mfa.totpSecret': ciphertext } });
      expect(await readStoredSecret()).toBe(ciphertext);
    });
  });

  describe('legacy plaintext rows (pre-backfill)', () => {
    beforeEach(async () => {
      await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $set: { mfa: mfaWith(TOTP_SECRET) } }
      );
    });

    it('findByIdWithMfaSecrets passes the plaintext through', async () => {
      expect(await readStoredSecret()).toBe(TOTP_SECRET);
      expect((await userRepository.findByIdWithMfaSecrets(userId))!.mfa!.totpSecret).toBe(TOTP_SECRET);
    });

    it('atomicEnableMfa still enables against the plaintext row', async () => {
      expect(await userRepository.atomicEnableMfa(userId, TOTP_SECRET)).not.toBeNull();
      expect((await userRepository.findByIdWithMfaSecrets(userId))!.mfa!.totpEnabled).toBe(true);
    });
  });

  describe('atomicEnableMfa against an encrypted secret', () => {
    beforeEach(async () => {
      await userRepository.update({ id: userId, mfa: mfaWith(TOTP_SECRET) });
    });

    it('enables when the verified plaintext matches the stored ciphertext', async () => {
      const enabled = await userRepository.atomicEnableMfa(userId, TOTP_SECRET);
      expect(enabled).not.toBeNull();
      expect(enabled!.mfa!.totpEnabled).toBe(true);
      // The enable write leaves the stored secret encrypted.
      await expectStoredEncrypted(TOTP_SECRET);
    });

    it('refuses a secret that does not match the stored one', async () => {
      expect(await userRepository.atomicEnableMfa(userId, OTHER_SECRET)).toBeNull();
      expect((await userRepository.findByIdWithMfaSecrets(userId))!.mfa!.totpEnabled).toBe(false);
    });

    it('refuses once a concurrent setup has replaced the secret', async () => {
      await userRepository.update({ id: userId, mfa: mfaWith(OTHER_SECRET) });
      expect(await userRepository.atomicEnableMfa(userId, TOTP_SECRET)).toBeNull();
      const mfa = (await userRepository.findByIdWithMfaSecrets(userId))!.mfa!;
      expect(mfa.totpEnabled).toBe(false);
      expect(mfa.totpSecret).toBe(OTHER_SECRET);
    });
  });

  it('an undecryptable secret reads as empty and a write-back of it leaves the stored value intact', async () => {
    const foreignCiphertext = encryptSecret(TOTP_SECRET, generateEncryptionKey());
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { mfa: { ...mfaWith(foreignCiphertext), totpEnabled: true } } }
    );

    const snapshot = await userRepository.findByIdWithMfaSecrets(userId);
    expect(snapshot!.mfa!.totpSecret).toBe('');

    // The secret-less guard drops the '' snapshot instead of overwriting the stored ciphertext.
    await userRepository.update({ id: userId, mfa: { ...snapshot!.mfa!, failedAttempts: 0 } });
    expect(await readStoredSecret()).toBe(foreignCiphertext);
  });
});
