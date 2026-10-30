import { createHash } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import SecretRotation, { secretRotationRepository } from './SecretRotationModel';

const GRACE_MS = 24 * 60 * 60 * 1000;

const rotateAt = (agoMs: number, over: Record<string, unknown> = {}) =>
  SecretRotation.create({
    keyName: 'JWT_SECRET',
    rotatedAt: new Date(Date.now() - agoMs),
    nextRotation: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    rotationIntervalDays: 90,
    previousKey: 'outgoing-secret',
    ...over,
  });

const stored = (id: unknown) => SecretRotation.findOne({ _id: id }).select('+previousKey');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SecretRotationRepository.expirePreviousKey', () => {
  setupMongoTest();

  it('clears a rotated-out secret after the grace window and records its fingerprint', async () => {
    const row = await rotateAt(GRACE_MS + 60 * 60 * 1000);

    await secretRotationRepository.expirePreviousKey('JWT_SECRET', GRACE_MS);

    const after = await stored(row._id);
    expect(after?.previousKey).toBeUndefined();
    expect(after?.capturedKeyFingerprint).toBe(createHash('sha256').update('outgoing-secret').digest('hex'));
  });

  it('keeps a secret still inside its grace window', async () => {
    const row = await rotateAt(60 * 60 * 1000);

    await secretRotationRepository.expirePreviousKey('JWT_SECRET', GRACE_MS);

    expect((await stored(row._id))?.previousKey).toBe('outgoing-secret');
  });

  it('compare-and-swaps on rotatedAt so a concurrent renew is not cleared', async () => {
    const row = await rotateAt(GRACE_MS + 60 * 60 * 1000);
    const updateOne = vi.spyOn(SecretRotation, 'updateOne');

    await secretRotationRepository.expirePreviousKey('JWT_SECRET', GRACE_MS);

    // The filter pins the identity AND the rotation instant this decision was made on.
    expect(updateOne.mock.calls[0][0]).toMatchObject({ _id: row._id, rotatedAt: row.rotatedAt });
  });

  it('is a no-op for a row with no rotated-out secret', async () => {
    const row = await rotateAt(GRACE_MS + 60 * 60 * 1000, { previousKey: undefined });

    await secretRotationRepository.expirePreviousKey('JWT_SECRET', GRACE_MS);

    expect((await stored(row._id))?.capturedKeyFingerprint).toBeUndefined();
  });

  it('leaves findByKeyNameWithSecret read-only', async () => {
    const row = await rotateAt(GRACE_MS + 60 * 60 * 1000);

    const found = await secretRotationRepository.findByKeyNameWithSecret('JWT_SECRET');

    expect(found?.previousKey).toBe('outgoing-secret');
    expect((await stored(row._id))?.previousKey).toBe('outgoing-secret');
  });
});
