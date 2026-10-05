import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { runGenerationJobSweep } from './sweep';

describe('runGenerationJobSweep', () => {
  it('re-enqueues overdue jobs immediately and leaves on-schedule jobs alone', async () => {
    const now = new Date('2026-10-06T01:00:00Z');
    const repository = createInMemoryGenerationJobRepository({ now: () => now });
    const base = {
      kind: 'video',
      ownerType: CreditHolderType.User,
      ownerId: 'u1',
      requestedBy: 'u1',
      source: 'studio',
      payload: {} as IGenerationJob['payload'],
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      deadlineAt: now,
      creditHold: null,
    } as const;
    const overdue = await repository.createJob({
      ...base,
      state: 'running',
      nextPollAt: new Date('2026-10-06T00:50:00Z'),
    });
    await repository.createJob({ ...base, state: 'running', nextPollAt: new Date('2026-10-06T00:59:00Z') });
    const enqueue = vi.fn(async (_jobId: string, _delay: number) => undefined);

    const result = await runGenerationJobSweep({ repository, enqueue, now: () => now, logger: new Logger() });

    expect(result).toEqual({ requeued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(overdue.id, 0);
  });
});
