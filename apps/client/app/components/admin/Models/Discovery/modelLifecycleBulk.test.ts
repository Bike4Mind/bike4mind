import { describe, expect, it, vi } from 'vitest';
import { runBulkResolution } from './modelLifecycleBulk';

const blocked = (details: string[]) =>
  Object.assign(new Error('Request failed with status code 409'), {
    response: { status: 409, data: { code: 'replacement-blocked', details } },
  });

describe('runBulkResolution', () => {
  it('posts one accept per row with the shared note and no override fields', async () => {
    const post = vi.fn().mockResolvedValue({});
    const results = await runBulkResolution({
      modelIds: ['a', 'b'],
      action: 'accept',
      note: '  Confirmed on vendor page.  ',
      post,
    });

    expect(post.mock.calls.map(([body]) => body)).toEqual([
      { modelId: 'a', action: 'accept', note: 'Confirmed on vendor page.' },
      { modelId: 'b', action: 'accept', note: 'Confirmed on vendor page.' },
    ]);
    expect(results).toEqual([
      { modelId: 'a', outcome: 'settled' },
      { modelId: 'b', outcome: 'settled' },
    ]);
  });

  it('reports a replacement-blocked row individually and never acknowledges it', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(blocked(['costs more than gpt-old']))
      .mockResolvedValueOnce({});

    const results = await runBulkResolution({ modelIds: ['a', 'b', 'c'], action: 'accept', note: 'n', post });

    expect(results).toEqual([
      { modelId: 'a', outcome: 'settled' },
      { modelId: 'b', outcome: 'blocked', blockers: ['costs more than gpt-old'] },
      { modelId: 'c', outcome: 'settled' },
    ]);
    // Exactly one request per row: the blocked one is not re-sent with acknowledgeBlockers.
    expect(post).toHaveBeenCalledTimes(3);
    for (const [body] of post.mock.calls) expect(body).not.toHaveProperty('acknowledgeBlockers');
  });

  it('keeps going past a plain failure and carries the server message', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Request failed'), {
          response: { status: 400, data: { message: "a's suggestion was already accepted" } },
        })
      )
      .mockResolvedValueOnce({});

    const results = await runBulkResolution({ modelIds: ['a', 'b'], action: 'dismiss', note: '', post });

    expect(results).toEqual([
      { modelId: 'a', outcome: 'failed', message: "a's suggestion was already accepted" },
      { modelId: 'b', outcome: 'settled' },
    ]);
  });

  it('reads the message from the error envelope the admin routes answer with', async () => {
    const post = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: "a's suggestion was already dismissed", requestId: 'r1' } },
      })
    );

    const results = await runBulkResolution({ modelIds: ['a'], action: 'dismiss', note: '', post });

    expect(results).toEqual([{ modelId: 'a', outcome: 'failed', message: "a's suggestion was already dismissed" }]);
  });

  it('sends a dismiss without a note when none is given, and with it when one is', async () => {
    const post = vi.fn().mockResolvedValue({});
    await runBulkResolution({ modelIds: ['a'], action: 'dismiss', note: ' ', post });
    await runBulkResolution({ modelIds: ['b'], action: 'dismiss', note: 'duplicate signal', post });

    expect(post.mock.calls.map(([body]) => body)).toEqual([
      { modelId: 'a', action: 'dismiss' },
      { modelId: 'b', action: 'dismiss', note: 'duplicate signal' },
    ]);
  });

  it('refuses a bulk accept with a blank note before sending anything', async () => {
    const post = vi.fn();
    await expect(runBulkResolution({ modelIds: ['a'], action: 'accept', note: '   ', post })).rejects.toThrow(
      /note is required/
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('reports progress after each row', async () => {
    const onProgress = vi.fn();
    await runBulkResolution({
      modelIds: ['a', 'b'],
      action: 'dismiss',
      note: '',
      post: vi.fn().mockResolvedValue({}),
      onProgress,
    });
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
