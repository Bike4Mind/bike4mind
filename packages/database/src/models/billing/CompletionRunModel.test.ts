import { describe, it, expect } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { CompletionRunModel, completionRunRepository } from './CompletionRunModel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('CompletionRunModel', () => {
  setupMongoTest();

  it('mints a random UUID bound to the caller and billing owner, and reads it back', async () => {
    const created = await completionRunRepository.create({
      userId: 'user-1',
      ownerType: CreditHolderType.Organization,
      ownerId: 'org-1',
      apiKeyId: 'key-1',
      rootSessionId: 'session-1',
    });

    expect(created.runId).toMatch(UUID);
    expect(created).toMatchObject({
      userId: 'user-1',
      ownerType: CreditHolderType.Organization,
      ownerId: 'org-1',
      apiKeyId: 'key-1',
      rootSessionId: 'session-1',
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    await expect(completionRunRepository.findById(created.runId)).resolves.toEqual(created);
  });

  it('gives every run its own id and leaves unset optional fields off', async () => {
    const owner = { userId: 'user-1', ownerType: CreditHolderType.User, ownerId: 'user-1' } as const;
    const [first, second] = await Promise.all([
      completionRunRepository.create(owner),
      completionRunRepository.create(owner),
    ]);

    expect(first.runId).not.toBe(second.runId);
    expect(first).not.toHaveProperty('apiKeyId');
    expect(first).not.toHaveProperty('rootSessionId');
  });

  it('returns null for an unknown or non-UUID id rather than throwing a cast error', async () => {
    await expect(completionRunRepository.findById('0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80')).resolves.toBeNull();
    await expect(completionRunRepository.findById('not-a-uuid')).resolves.toBeNull();
  });

  it('keeps the owner binding immutable', async () => {
    const { runId } = await completionRunRepository.create({
      userId: 'user-1',
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
    });

    await CompletionRunModel.updateOne({ _id: runId }, { $set: { userId: 'user-2', ownerId: 'user-2' } });

    await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({
      userId: 'user-1',
      ownerId: 'user-1',
    });
  });
});
