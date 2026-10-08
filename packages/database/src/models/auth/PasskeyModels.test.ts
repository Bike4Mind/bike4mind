import { describe, it, expect } from 'vitest';
import { PasskeyChallengeModel, passkeyChallengeRepository, PASSKEY_CHALLENGE_TTL_MS } from './PasskeyChallengeModel';
import { passkeyCredentialRepository } from './PasskeyCredentialModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const makePasskey = (userId: string, credentialId = `cred-${Math.random()}`) =>
  passkeyCredentialRepository.create({
    userId,
    credentialId,
    publicKey: 'pub',
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    name: 'Laptop',
  });

/** A challenge that can be redeemed twice lets a captured ceremony response be replayed. */
describe('passkeyChallengeRepository', () => {
  it('returns an issued challenge exactly once', async () => {
    await passkeyChallengeRepository.issue('user-a', 'authentication', 'chal-1');
    expect(await passkeyChallengeRepository.consume('user-a', 'authentication')).toBe('chal-1');
    expect(await passkeyChallengeRepository.consume('user-a', 'authentication')).toBeNull();
  });

  it('keeps only the newest challenge per user and purpose', async () => {
    await passkeyChallengeRepository.issue('user-a', 'authentication', 'old');
    await passkeyChallengeRepository.issue('user-a', 'authentication', 'new');
    expect(await PasskeyChallengeModel.countDocuments({ userId: 'user-a' })).toBe(1);
    expect(await passkeyChallengeRepository.consume('user-a', 'authentication')).toBe('new');
  });

  it('isolates challenges by user and purpose', async () => {
    await passkeyChallengeRepository.issue('user-a', 'registration', 'reg');
    expect(await passkeyChallengeRepository.consume('user-b', 'registration')).toBeNull();
    expect(await passkeyChallengeRepository.consume('user-a', 'authentication')).toBeNull();
    expect(await passkeyChallengeRepository.consume('user-a', 'registration')).toBe('reg');
  });

  it('does not return a challenge older than the TTL even before the reaper runs', async () => {
    await passkeyChallengeRepository.issue('user-a', 'authentication', 'stale');
    await PasskeyChallengeModel.updateOne(
      { userId: 'user-a' },
      { $set: { createdAt: new Date(Date.now() - PASSKEY_CHALLENGE_TTL_MS - 1000) } }
    );
    expect(await passkeyChallengeRepository.consume('user-a', 'authentication')).toBeNull();
  });
});

describe('passkeyCredentialRepository', () => {
  it("never looks up or removes another user's credential", async () => {
    const passkey = await makePasskey('user-a', 'shared-cred');
    expect(await passkeyCredentialRepository.findByCredentialId('user-b', 'shared-cred')).toBeNull();
    expect(await passkeyCredentialRepository.remove(passkey.id, 'user-b')).toBe(false);
    expect((await passkeyCredentialRepository.findByCredentialId('user-a', 'shared-cred'))?.id).toBe(passkey.id);
  });

  it('records a use by advancing the counter and stamping lastUsedAt', async () => {
    const passkey = await makePasskey('user-a', 'cred-x');
    await passkeyCredentialRepository.recordUse(passkey.id, 7);
    const stored = await passkeyCredentialRepository.findByCredentialId('user-a', 'cred-x');
    expect(stored?.counter).toBe(7);
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('removes all of a user and nobody else', async () => {
    await makePasskey('user-a');
    await makePasskey('user-a');
    await makePasskey('user-b');
    expect(await passkeyCredentialRepository.removeAllForUser('user-a')).toBe(2);
    expect(await passkeyCredentialRepository.countByUser('user-b')).toBe(1);
  });

  it('returns false for a malformed id instead of throwing a cast error', async () => {
    expect(await passkeyCredentialRepository.remove('not-an-id', 'user-a')).toBe(false);
  });
});
