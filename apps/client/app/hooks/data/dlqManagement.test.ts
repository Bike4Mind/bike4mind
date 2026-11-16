import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import { runDlqBatches } from './dlqManagement';

describe('runDlqBatches', () => {
  it('sends each queue in chunks of 100 and tags every outcome with its queue', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `m${index}`);
    const send = vi.fn(async (_queue: string, chunk: string[]) => ({
      results: chunk.map(messageId => ({ messageId, status: 'replayed' as const })),
    }));
    const outcomes = await runDlqBatches(
      new Map([
        ['billing', ids],
        ['files', ['f1']],
      ]),
      send
    );
    expect(send.mock.calls.map(([queue, chunk]) => [queue, chunk.length])).toEqual([
      ['billing', 100],
      ['billing', 50],
      ['files', 1],
    ]);
    expect(outcomes).toHaveLength(151);
    expect(outcomes.at(-1)).toEqual({ messageId: 'f1', queueLabel: 'files', status: 'replayed' });
  });

  it('reports an ID the server did not answer as not found', async () => {
    const outcomes = await runDlqBatches(new Map([['q', ['a', 'b']]]), async () => ({
      results: [{ messageId: 'a', status: 'replayed' as const }],
    }));
    expect(outcomes.map(outcome => [outcome.messageId, outcome.status])).toEqual([
      ['a', 'replayed'],
      ['b', 'notFound'],
    ]);
  });

  it('marks a failed chunk as failed and still sends the next queue', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ results: [{ messageId: 'c', status: 'replayed' }] });
    const outcomes = await runDlqBatches(
      new Map([
        ['q1', ['a', 'b']],
        ['q2', ['c']],
      ]),
      send
    );
    expect(outcomes).toEqual([
      { messageId: 'a', queueLabel: 'q1', status: 'failed', reason: 'throttled' },
      { messageId: 'b', queueLabel: 'q1', status: 'failed', reason: 'throttled' },
      { messageId: 'c', queueLabel: 'q2', status: 'replayed' },
    ]);
  });
});
