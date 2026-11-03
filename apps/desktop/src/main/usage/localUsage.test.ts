import type { ChatMessage, ChatUsage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { localUsageWindow, sessionUsageBuckets, serverLabel, type LocalUsageBucket } from './localUsage';

const NOW = Date.parse('2026-11-02T15:20:00.000Z');
const OLLAMA = 'local:ollama:llama3.2';
const SERVER = 'local:srv-box:qwen3';

let next = 0;
/** `model` null is a reply stored before replies were stamped. */
function reply(at: string, usage: ChatUsage, model: string | null = OLLAMA): ChatMessage {
  return {
    id: `m${next++}`,
    role: 'assistant',
    content: 'x',
    createdAt: at,
    ...(model ? { model } : {}),
    usage,
  };
}

function buckets(messages: ChatMessage[], model = OLLAMA): LocalUsageBucket[] {
  return sessionUsageBuckets({ model, messages });
}

const NAMES = new Map([['box', 'Studio box']]);

describe('sessionUsageBuckets', () => {
  it('counts assistant replies on local models by model and UTC hour, from message.usage only', () => {
    const result = buckets([
      { id: 'u', role: 'user', content: 'hi', createdAt: '2026-11-02T15:01:00.000Z' },
      {
        ...reply('2026-11-02T15:05:00.000Z', { inputTokens: 900, outputTokens: 40 }),
        rounds: [{ text: 'x', toolCallIds: [], usage: { outputTokens: 40 } }],
      },
      reply('2026-11-02T15:55:00.000Z', { inputTokens: 1000, outputTokens: 60 }),
      reply('2026-11-02T16:01:00.000Z', { outputTokens: 5 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ model: OLLAMA, replies: 2, outputTokens: 100, contextTokens: 1900 });
    expect(result[0].hour).toBe(Date.parse('2026-11-02T15:00:00.000Z'));
    expect(result[1]).toMatchObject({ replies: 1, outputTokens: 5 });
  });

  it('prefers the reply model stamp over the session model', () => {
    const result = buckets(
      [
        reply('2026-11-02T15:05:00.000Z', { outputTokens: 1 }, SERVER),
        reply('2026-11-02T15:07:00.000Z', { outputTokens: 4 }, 'claude-sonnet-5'),
      ],
      OLLAMA
    );
    expect(result.map(bucket => [bucket.model, bucket.outputTokens])).toEqual([[SERVER, 1]]);
  });

  it('attributes an unstamped reply by its context snapshot, else by the session only when it has a rate', () => {
    const at = '2026-11-02T15:05:00.000Z';
    const snapshot = (model: string) => ({ model, inputTokens: 10, overhead: [] });
    const result = buckets(
      [
        { ...reply(at, { outputTokens: 1 }, null), contextSnapshot: snapshot(SERVER) },
        { ...reply(at, { outputTokens: 2 }, null), contextSnapshot: snapshot('claude-sonnet-5') },
        reply(at, { outputTokens: 4, rate: { evalTokens: 4, evalMs: 100 } }, null),
        reply(at, { outputTokens: 8 }, null),
        {
          ...reply(at, { outputTokens: 16, rate: { evalTokens: 16, evalMs: 100 } }, null),
          promptCache: { cachedAt: Date.parse(at), ttl: '5m', model: 'claude-sonnet-5' },
        },
      ],
      OLLAMA
    );
    expect(result.map(bucket => [bucket.model, bucket.outputTokens])).toEqual([
      [SERVER, 1],
      [OLLAMA, 4],
    ]);
  });

  it('skips hosted replies, replies without usage and unreadable timestamps', () => {
    expect(buckets([reply('2026-11-02T15:05:00.000Z', { outputTokens: 3 }, 'claude-sonnet-5')])).toEqual([]);
    const noUsage: ChatMessage = { id: 'n', role: 'assistant', content: 'x', createdAt: '2026-11-02T15:05:00.000Z' };
    expect(buckets([noUsage, reply('not a date', { outputTokens: 3 })])).toEqual([]);
  });

  it('keeps measured, estimated and untimed replies apart', () => {
    const [bucket] = buckets([
      reply('2026-11-02T15:01:00.000Z', {
        outputTokens: 100,
        rate: { evalTokens: 100, evalMs: 2000, promptTokens: 500, promptMs: 250, loadMs: 1200 },
      }),
      reply('2026-11-02T15:02:00.000Z', {
        outputTokens: 50,
        rate: { evalTokens: 49, evalMs: 1000, estimated: true },
      }),
      reply('2026-11-02T15:03:00.000Z', { outputTokens: 20 }),
      reply('2026-11-02T15:04:00.000Z', {
        outputTokens: 30,
        rate: { evalTokens: 30, evalMs: 600, draftTokens: 20, draftAccepted: 15 },
      }),
    ]);
    expect(bucket).toMatchObject({
      replies: 4,
      outputTokens: 200,
      timedReplies: 2,
      evalTokens: 130,
      evalMs: 2600,
      estimatedReplies: 1,
      estimatedEvalTokens: 49,
      estimatedEvalMs: 1000,
      promptTokens: 500,
      promptMs: 250,
      loads: 1,
      loadMs: 1200,
      draftTokens: 20,
      draftAccepted: 15,
    });
  });
});

describe('localUsageWindow', () => {
  function bucket(model: string, at: string, figures: Partial<LocalUsageBucket>): LocalUsageBucket {
    const [made] = sessionUsageBuckets({ model, messages: [reply(at, { outputTokens: 0 }, model)] });
    return { ...made, ...figures };
  }

  it('takes the speed as a ratio of sums, not a mean of per-reply rates', () => {
    // 1000 tokens in 10s and 10 tokens in 1s: a mean of rates would say 55 tok/s, the sums ~91.8.
    const result = localUsageWindow(
      [
        bucket(OLLAMA, '2026-11-02T15:00:00.000Z', { evalTokens: 1000, evalMs: 10_000, timedReplies: 1 }),
        bucket(OLLAMA, '2026-11-02T14:00:00.000Z', { evalTokens: 10, evalMs: 1000, timedReplies: 1 }),
      ],
      'last-24-hours',
      NOW,
      NAMES
    );
    expect((result.totals.evalTokens / result.totals.evalMs) * 1000).toBeCloseTo(91.8, 1);
    expect(result.byModel[0]).toMatchObject({ evalTokens: 1010, evalMs: 11_000 });
  });

  it('draws 24 UTC hour bars ending in the current hour, and drops buckets outside them', () => {
    const result = localUsageWindow(
      [
        bucket(OLLAMA, '2026-11-02T15:10:00.000Z', { outputTokens: 7 }),
        bucket(OLLAMA, '2026-11-01T16:59:00.000Z', { outputTokens: 3 }),
        bucket(OLLAMA, '2026-11-01T15:59:00.000Z', { outputTokens: 1000 }),
        bucket(OLLAMA, '2026-11-02T16:00:00.000Z', { outputTokens: 1000 }),
      ],
      'last-24-hours',
      NOW,
      NAMES
    );
    expect(result.granularity).toBe('hour');
    expect(result.bars).toHaveLength(24);
    expect(result.bars[0]).toMatchObject({ startsAt: '2026-11-01T16:00:00.000Z', outputTokens: 3, replies: 1 });
    expect(result.bars[23]).toMatchObject({ startsAt: '2026-11-02T15:00:00.000Z', outputTokens: 7 });
    expect(result.totals.outputTokens).toBe(10);
    expect(result.totals.replies).toBe(2);
    expect(result.allTimeReplies).toBe(4);
  });

  it('draws the 30-day window as UTC days, like the credit chart', () => {
    const result = localUsageWindow(
      [
        bucket(OLLAMA, '2026-10-03T00:00:00.000Z', { outputTokens: 5 }),
        bucket(OLLAMA, '2026-10-02T23:00:00.000Z', { outputTokens: 1000 }),
        bucket(OLLAMA, '2026-11-02T01:00:00.000Z', { outputTokens: 2 }),
        bucket(OLLAMA, '2026-11-02T14:00:00.000Z', { outputTokens: 2 }),
      ],
      'last-30-days',
      NOW,
      NAMES
    );
    expect(result.bars).toHaveLength(31);
    expect(result.bars[0]).toMatchObject({ startsAt: '2026-10-03T00:00:00.000Z', outputTokens: 5 });
    expect(result.bars[30]).toMatchObject({ startsAt: '2026-11-02T00:00:00.000Z', outputTokens: 4, replies: 2 });
    expect(result.totals.outputTokens).toBe(9);
  });

  it('breaks down by model name across servers, and by server name', () => {
    const result = localUsageWindow(
      [
        bucket(OLLAMA, '2026-11-02T15:00:00.000Z', { outputTokens: 10 }),
        bucket('local:srv-box:llama3.2', '2026-11-02T15:00:00.000Z', { outputTokens: 30 }),
        bucket(SERVER, '2026-11-02T14:00:00.000Z', { outputTokens: 5 }),
        bucket('local:srv-gone:qwen3', '2026-11-02T14:00:00.000Z', { outputTokens: 1 }),
        bucket('local:srv-old:qwen3', '2026-11-02T14:00:00.000Z', { outputTokens: 1 }),
      ],
      'last-24-hours',
      NOW,
      NAMES
    );
    expect(result.byModel.map(row => [row.label, row.outputTokens, row.replies])).toEqual([
      ['llama3.2', 40, 2],
      ['qwen3', 7, 3],
    ]);
    expect(result.byServer.map(row => [row.label, row.outputTokens])).toEqual([
      ['Studio box', 35],
      ['This computer', 10],
      ['Removed server', 2],
    ]);
  });
});

describe('serverLabel', () => {
  it('names this computer, a saved server, and one that was removed', () => {
    expect(serverLabel('ollama', NAMES)).toBe('This computer');
    expect(serverLabel('srv-box', NAMES)).toBe('Studio box');
    expect(serverLabel('srv-gone', NAMES)).toBe('Removed server');
  });

  it('keeps the runtime id when the saved servers could not be read', () => {
    expect(serverLabel('ollama', null)).toBe('This computer');
    expect(serverLabel('srv-box', null)).toBe('srv-box');
  });
});
