import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ AppFile: { findOne: h.findOne, updateOne: h.updateOne } }));
vi.mock('@bike4mind/server-utils/s3/utils', () => ({
  withContext: (fn: unknown) => fn,
  decodeS3Key: (key: string) => key,
  findWithRetry: (fn: () => unknown) => fn(),
}));

import { func } from './appFileUploadComplete';

const logger = { updateMetadata: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() };
const run = (key: string) =>
  (func as unknown as (event: unknown, context: unknown, logger: unknown) => Promise<void>)(
    { Records: [{ s3: { object: { key } } }] },
    {},
    logger
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.findOne.mockResolvedValue({ _id: 'file-1', id: 'file-1', userId: 'owner' });
  h.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('AppFile completion', () => {
  it('only completes the pending row for the landed key', async () => {
    await run('photos/original.png');
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'file-1', path: 'photos/original.png', status: 'pending' },
      { $set: { status: 'complete' } }
    );
  });

  it('does not update a row when a delayed event has no matching key', async () => {
    h.findOne.mockResolvedValue(null);
    await run('photos/retired.png');
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('does not save a stale snapshot on replay or a failed conditional update', async () => {
    const save = vi.fn();
    h.findOne.mockResolvedValue({ _id: 'file-1', id: 'file-1', userId: 'owner', save });
    h.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await run('photos/original.png');
    expect(save).not.toHaveBeenCalled();
  });
});
