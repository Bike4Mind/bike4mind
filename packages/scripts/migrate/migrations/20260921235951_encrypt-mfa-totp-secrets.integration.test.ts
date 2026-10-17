import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User, userRepository } from '@bike4mind/database';
import { configureSecretsAtRest, encryptSecret, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirror the sibling migration tests' guard so a transitive SST config import stays inert.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235951_encrypt-mfa-totp-secrets';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const KEY = generateEncryptionKey();
const PLAIN_SECRET = 'JBSWY3DPEHPK3PXP';
const ALREADY_ENCRYPTED_PLAINTEXT = 'KRSXG5CTMVRXEZLU';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  configureSecretsAtRest(undefined);
  await mongoose.disconnect();
  await server.stop();
});

// Raw inserts: the rows must look like pre-encryption data, which the User model's write hooks
// would otherwise encrypt on the way in.
const insertUser = async (username: string, totpSecret?: string) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username,
    email: `${username}@example.com`,
    name: username,
    ...(totpSecret ? { mfa: { totpSecret, totpEnabled: true, backupCodes: [], setupAt: new Date() } } : {}),
  });
  return _id;
};
const storedSecret = async (_id: mongoose.Types.ObjectId) => {
  const raw = await User.collection.findOne({ _id });
  return (raw?.mfa as { totpSecret?: string } | undefined)?.totpSecret;
};

beforeEach(async () => {
  configureSecretsAtRest(KEY);
  await User.collection.deleteMany({});
});

describe('encrypt-mfa-totp-secrets migration (real DB)', () => {
  it('encrypts plaintext secrets, leaves ciphertext and non-enrolled users alone', async () => {
    const plainId = await insertUser('plain', PLAIN_SECRET);
    const preEncrypted = encryptSecret(ALREADY_ENCRYPTED_PLAINTEXT, KEY);
    const encryptedId = await insertUser('encrypted', preEncrypted);
    const noMfaId = await insertUser('no-mfa');

    await migration.up();

    const migrated = await storedSecret(plainId);
    expect(isEncrypted(migrated ?? '')).toBe(true);
    expect(await storedSecret(encryptedId)).toBe(preEncrypted);
    expect((await User.collection.findOne({ _id: noMfaId }))?.mfa).toBeUndefined();

    // A migrated user still verifies: the read path decrypts back to the original seed.
    const user = await userRepository.findByIdWithMfaSecrets(plainId.toString());
    expect(user!.mfa!.totpSecret).toBe(PLAIN_SECRET);
  });

  it('is idempotent on re-run', async () => {
    const plainId = await insertUser('plain', PLAIN_SECRET);

    await migration.up();
    const first = await storedSecret(plainId);
    await migration.up();

    expect(await storedSecret(plainId)).toBe(first);
  });

  it('does not overwrite a secret a concurrent re-enrollment wrote after the scan', async () => {
    const reEnrolled = encryptSecret(ALREADY_ENCRYPTED_PLAINTEXT, KEY);
    const userId = await insertUser('re-enrolled', reEnrolled);
    // The scan saw the pre-re-enrollment plaintext; the row now holds the new ciphertext.
    const findSpy = vi.spyOn(User, 'find').mockReturnValueOnce({
      select: () => ({ lean: async () => [{ _id: userId, mfa: { totpSecret: PLAIN_SECRET } }] }),
    } as unknown as ReturnType<typeof User.find>);

    try {
      await migration.up();
    } finally {
      findSpy.mockRestore();
    }

    expect(await storedSecret(userId)).toBe(reEnrolled);
  });

  it('leaves plaintext in place without throwing when no key is configured', async () => {
    configureSecretsAtRest(undefined);
    const plainId = await insertUser('plain', PLAIN_SECRET);

    await expect(migration.up()).resolves.toBeUndefined();
    expect(await storedSecret(plainId)).toBe(PLAIN_SECRET);
  });
});
