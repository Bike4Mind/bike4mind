import { describe, expect, it, vi } from 'vitest';
import type { IGenerationJobDocument } from '@bike4mind/common';
import { findOwnVideoJob } from './findOwnVideoJob';

const ID = '664f1c2b9a1e4d0012ab34cd';
const repo = (job: Partial<IGenerationJobDocument> | null) => ({
  findById: vi.fn(async () => job as IGenerationJobDocument | null),
});

describe('findOwnVideoJob', () => {
  it('returns the caller own video job', async () => {
    const job = { id: ID, kind: 'video' as const, requestedBy: 'u1' };
    await expect(findOwnVideoJob(ID, 'u1', repo(job))).resolves.toEqual(job);
  });

  it('hides another member of the same org', async () => {
    const r = repo({ id: ID, kind: 'video', requestedBy: 'u2', ownerId: 'org1' });
    await expect(findOwnVideoJob(ID, 'u1', r)).resolves.toBeNull();
  });

  it('treats a malformed id as missing without querying', async () => {
    const r = repo(null);
    await expect(findOwnVideoJob('not-an-id', 'u1', r)).resolves.toBeNull();
    await expect(findOwnVideoJob(ID.toUpperCase(), 'u1', r)).resolves.toBeNull();
    expect(r.findById).not.toHaveBeenCalled();
  });
});
