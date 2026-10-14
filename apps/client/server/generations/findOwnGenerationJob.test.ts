import { describe, expect, it, vi } from 'vitest';
import type { IGenerationJobDocument } from '@bike4mind/common';
import { findOwnGenerationJob } from './findOwnGenerationJob';

const ID = '664f1c2b9a1e4d0012ab34cd';
const repo = (job: Partial<IGenerationJobDocument> | null) => ({
  findById: vi.fn(async () => job as IGenerationJobDocument | null),
});

describe('findOwnGenerationJob', () => {
  it('returns the caller own job of the requested kind', async () => {
    const job = { id: ID, kind: 'video' as const, requestedBy: 'u1' };
    await expect(findOwnGenerationJob(ID, 'u1', 'video', repo(job))).resolves.toEqual(job);
  });

  it('hides another member of the same org', async () => {
    const r = repo({ id: ID, kind: 'video', requestedBy: 'u2', ownerId: 'org1' });
    await expect(findOwnGenerationJob(ID, 'u1', 'video', r)).resolves.toBeNull();
  });

  it('treats a malformed id as missing without querying', async () => {
    const r = repo(null);
    await expect(findOwnGenerationJob('not-an-id', 'u1', 'video', r)).resolves.toBeNull();
    await expect(findOwnGenerationJob(ID.toUpperCase(), 'u1', 'video', r)).resolves.toBeNull();
    expect(r.findById).not.toHaveBeenCalled();
  });
});
