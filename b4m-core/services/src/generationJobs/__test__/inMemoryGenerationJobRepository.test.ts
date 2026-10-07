import { describe, expect, it } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { createInMemoryGenerationJobRepository } from './inMemoryGenerationJobRepository';

describe('in-memory listByRequester', () => {
  it('pages newest first past job10, where a string sort would misorder', async () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const repository = createInMemoryGenerationJobRepository({ now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const job = await repository.createJob({
        kind: 'video',
        ownerType: CreditHolderType.User,
        ownerId: 'u1',
        requestedBy: 'u1',
        source: 'api',
        state: 'pending',
        payload: {} as IGenerationJob['payload'],
        pollCount: 0,
        attempts: 0,
        cancelRequested: false,
        deadlineAt: now,
        creditHold: null,
      });
      ids.push(job.id);
    }

    const first = await repository.listByRequester({ requestedBy: 'u1', kind: 'video', limit: 5 });
    expect(first.map(job => job.id)).toEqual(ids.slice(7).reverse());
    const next = await repository.listByRequester({
      requestedBy: 'u1',
      kind: 'video',
      beforeId: first[4].id,
      limit: 10,
    });
    expect(next.map(job => job.id)).toEqual(ids.slice(0, 7).reverse());
  });
});
