import { describe, it, expect, vi, beforeEach } from 'vitest';

type Doc = { _id: number; imageUrl: string };

const state = vi.hoisted(() => ({ docs: [] as { _id: number; imageUrl: string }[] }));
const updateOne = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({
  mongoose: {
    connection: {
      db: {
        collection: () => ({
          find: () => ({
            sort: () => ({ limit: () => ({ toArray: async () => state.docs }) }),
          }),
          updateOne,
        }),
      },
    },
  },
}));

import migration, { toModalImageKey } from './20260921000002_modal-image-url-to-key';

const SIGNED = 'https://bucket.s3.us-east-2.amazonaws.com/modal-images/abc.png?X-Amz-Algorithm=AWS4&X-Amz-Signature=s';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  updateOne.mockResolvedValue({ modifiedCount: 1 });
  state.docs = [];
});

describe('toModalImageKey', () => {
  it('extracts the key from a presigned modal-images URL', () => {
    expect(toModalImageKey(SIGNED)).toBe('modal-images/abc.png');
  });

  it('ignores external URLs, unsigned URLs and other prefixes', () => {
    expect(toModalImageKey('https://cdn.example.com/modal-images/a.png')).toBeNull();
    expect(toModalImageKey('https://b.s3.amazonaws.com/uploads/a.png?X-Amz-Algorithm=AWS4')).toBeNull();
    expect(toModalImageKey('modal-images/abc.png')).toBeNull();
  });
});

describe('modal-image-url-to-key', () => {
  it('rewrites presigned URLs to bare keys', async () => {
    state.docs = [{ _id: 1, imageUrl: SIGNED } satisfies Doc];

    await migration.up();

    expect(updateOne).toHaveBeenCalledWith({ _id: 1 }, { $set: { imageUrl: 'modal-images/abc.png' } });
  });

  it('skips matched documents that are not rewritable', async () => {
    state.docs = [{ _id: 2, imageUrl: 'https://cdn.example.com/x.png' }];

    await migration.up();

    expect(updateOne).not.toHaveBeenCalled();
  });

  it('down writes nothing', async () => {
    await migration.down();
    expect(updateOne).not.toHaveBeenCalled();
  });
});
