import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  receiveFromQueue: vi.fn(),
  changeMessageVisibility: vi.fn(),
  countAttemptsByMessage: vi.fn(),
}));

vi.mock('./sqs', () => ({ receiveFromQueue: h.receiveFromQueue, changeMessageVisibility: h.changeMessageVisibility }));
vi.mock('./dlqRegistry', () => ({ getSourceQueueUrl: () => 'https://sqs.example/source' }));
vi.mock('@bike4mind/database', () => ({
  dlqFailureRepository: { findForMessages: vi.fn() },
  dlqReplayLogRepository: { countAttemptsByMessage: h.countAttemptsByMessage },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn() } }));

import {
  acquireDlqMessagesById,
  browseDlqMessages,
  countDlqReplayAttempts,
  latestCopies,
  messageLogsUrl,
  recommendForDlqMessage,
} from './dlqMessages';

const msg = (id: string, receives = 1) => ({
  MessageId: id,
  ReceiptHandle: `rh-${id}-${receives}`,
  Attributes: { ApproximateReceiveCount: String(receives) },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.changeMessageVisibility.mockResolvedValue(undefined);
});

describe('latestCopies', () => {
  it('keeps the copy of each message with the highest receive count', () => {
    expect(latestCopies([msg('a', 1), msg('b', 1), msg('a', 3)])).toEqual([msg('a', 3), msg('b', 1)]);
  });
});

describe('browseDlqMessages', () => {
  it('receives with visibility 0 until the limit is reached', async () => {
    h.receiveFromQueue.mockResolvedValueOnce([msg('a'), msg('b')]).mockResolvedValueOnce([msg('c'), msg('d')]);
    const messages = await browseDlqMessages('dlq', { limit: 3, maxReceives: 5 });
    expect(messages.map(m => m.MessageId)).toEqual(['a', 'b', 'c']);
    expect(h.receiveFromQueue).toHaveBeenCalledTimes(2);
    expect(h.receiveFromQueue).toHaveBeenCalledWith('dlq', 10, 0, 0, ['All']);
  });

  it('stops after two receives that surface nothing new', async () => {
    h.receiveFromQueue.mockResolvedValue([msg('a')]);
    const messages = await browseDlqMessages('dlq', { limit: 50, maxReceives: 8 });
    expect(messages.map(m => m.MessageId)).toEqual(['a']);
    expect(h.receiveFromQueue).toHaveBeenCalledTimes(3);
  });

  it('stops on an empty receive and never exceeds maxReceives', async () => {
    h.receiveFromQueue.mockResolvedValueOnce([]);
    await browseDlqMessages('dlq', { limit: 50, maxReceives: 8 });
    expect(h.receiveFromQueue).toHaveBeenCalledTimes(1);

    h.receiveFromQueue.mockReset();
    let n = 0;
    h.receiveFromQueue.mockImplementation(async () => [msg(`m${n++}`)]);
    await browseDlqMessages('dlq', { limit: 50, maxReceives: 4 });
    expect(h.receiveFromQueue).toHaveBeenCalledTimes(4);
  });
});

describe('acquireDlqMessagesById', () => {
  const options = { maxReceives: 5, visibilityTimeout: 60 };

  it('returns the wanted messages and releases everything else it received', async () => {
    h.receiveFromQueue.mockResolvedValueOnce([msg('x'), msg('a')]).mockResolvedValueOnce([msg('b'), msg('y')]);
    const { found, notFound } = await acquireDlqMessagesById('dlq', 'q', ['a', 'b'], options);
    expect(found.map(m => m.MessageId)).toEqual(['a', 'b']);
    expect(notFound).toEqual([]);
    expect(h.receiveFromQueue).toHaveBeenCalledWith('dlq', 10, 60, 1);
    expect(h.changeMessageVisibility.mock.calls.map(call => call[1])).toEqual(['rh-x-1', 'rh-y-1']);
  });

  it('reports IDs it never saw as not found', async () => {
    h.receiveFromQueue.mockResolvedValueOnce([msg('a')]).mockResolvedValueOnce([]);
    const { found, notFound } = await acquireDlqMessagesById('dlq', 'q', ['a', 'gone'], options);
    expect(found.map(m => m.MessageId)).toEqual(['a']);
    expect(notFound).toEqual(['gone']);
  });

  it('releases every message it received when a receive fails', async () => {
    h.receiveFromQueue.mockResolvedValueOnce([msg('a'), msg('x')]).mockRejectedValueOnce(new Error('throttled'));
    await expect(acquireDlqMessagesById('dlq', 'q', ['a', 'b'], options)).rejects.toThrow('throttled');
    expect(h.changeMessageVisibility.mock.calls.map(call => call[1]).sort()).toEqual(['rh-a-1', 'rh-x-1']);
  });
});

describe('countDlqReplayAttempts', () => {
  it('returns the batched counts, or null when the lookup fails', async () => {
    h.countAttemptsByMessage.mockResolvedValueOnce(new Map([['a', 2]]));
    expect(await countDlqReplayAttempts('q', ['a'])).toEqual(new Map([['a', 2]]));
    h.countAttemptsByMessage.mockRejectedValueOnce(new Error('mongo down'));
    expect(await countDlqReplayAttempts('q', ['a'])).toBeNull();
  });
});

describe('recommendForDlqMessage', () => {
  it('feeds the recorded failure, consumer update and attempts to the shared policy', () => {
    const failure = { category: 'timeout', failedAt: new Date('2026-01-01T00:00:00Z') } as Parameters<
      typeof recommendForDlqMessage
    >[0]['failure'];
    expect(recommendForDlqMessage({ failure, logs: null, replayAttempts: 0, replaySafety: 'safe' })).toMatchObject({
      action: 'replay',
    });
    expect(recommendForDlqMessage({ failure, logs: null, replayAttempts: 3, replaySafety: 'safe' })).toMatchObject({
      action: 'discard',
    });
    expect(
      recommendForDlqMessage({ failure: undefined, logs: null, replayAttempts: undefined, replaySafety: undefined })
    ).toMatchObject({ action: 'inspect' });
  });
});

describe('messageLogsUrl', () => {
  const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const sent = Date.UTC(2026, 0, 2, 3, 0, 0);
  const base = { logs: null, sentTimestamp: String(sent) };
  const decode = (url: string) =>
    decodeURIComponent(decodeURIComponent(url.split('#')[1].replace(/\$/g, '%')).replace(/\*/g, '%'));

  beforeEach(() => vi.stubEnv('AWS_REGION', 'us-east-2'));
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the source-queue window link when there is no request id', () => {
    const logs = { region: 'us-east-2', logGroups: ['/aws/lambda/consumer'], retryWindowMs: 60_000 };
    const link = messageLogsUrl({ ...base, logs });
    expect(link?.scope).toBe('window');
    expect(decode(link!.url)).toContain("'/aws/lambda/consumer");
  });

  it('links an EventBridge failure to the resolved log group of its target function', () => {
    const link = messageLogsUrl({
      ...base,
      targetLogs: { region: 'us-east-2', logGroup: '/sst/app/stage/Consumer-LogGroup' },
    });
    const detail = decode(link!.url);
    expect(link?.scope).toBe('window');
    expect(detail).toContain("source~(~'/sst/app/stage/Consumer-LogGroup)");
    expect(detail).toContain(`start~'${new Date(sent - 24 * 60 * 60_000).toISOString()}`);
  });

  it('prefers the TARGET_ARN log group over the schedule target', () => {
    const link = messageLogsUrl({
      ...base,
      targetLogs: { region: 'us-east-2', logGroup: '/sst/target' },
      scheduleLogs: { region: 'us-east-2', logGroup: '/sst/schedule' },
    });
    expect(decode(link!.url)).toContain("source~(~'/sst/target)");
  });

  it('filters on the request id over the scheduled run, using the rule target', () => {
    const scheduledAt = new Date(sent - 3 * 60 * 60_000).toISOString();
    const link = messageLogsUrl({
      ...base,
      requestId: REQUEST_ID,
      scheduledAt,
      scheduleLogs: { region: 'us-east-2', logGroup: '/sst/app/stage/Nightly-LogGroup' },
    });
    const detail = decode(link!.url);
    expect(link?.scope).toBe('request');
    expect(detail).toContain(`filter @requestId = "${REQUEST_ID}"`);
    expect(detail).toContain("source~(~'/sst/app/stage/Nightly-LogGroup)");
    expect(detail).toContain(`start~'${scheduledAt}`);
    expect(detail).toContain(`end~'${new Date(sent + 5 * 60_000).toISOString()}`);
  });

  it('clamps a forged scheduled time to the retry window', () => {
    const link = messageLogsUrl({
      ...base,
      requestId: REQUEST_ID,
      scheduledAt: '2000-01-01T00:00:00.000Z',
      scheduleLogs: { region: 'us-east-2', logGroup: '/sst/app/stage/Nightly-LogGroup' },
    });
    expect(decode(link!.url)).toContain(`start~'${new Date(sent - 6 * 60 * 60_000).toISOString()}`);
  });

  it('drops a log group outside the deploy region', () => {
    expect(messageLogsUrl({ ...base, targetLogs: { region: 'eu-west-1', logGroup: '/sst/other' } })).toBeNull();
    expect(
      messageLogsUrl({
        ...base,
        requestId: REQUEST_ID,
        scheduleLogs: { region: 'eu-west-1', logGroup: '/sst/other' },
      })
    ).toBeNull();
  });

  it('returns null with no resolved log group or no send time', () => {
    expect(messageLogsUrl({ ...base, requestId: REQUEST_ID })).toBeNull();
    expect(
      messageLogsUrl({
        logs: null,
        sentTimestamp: undefined,
        targetLogs: { region: 'us-east-2', logGroup: '/sst/f' },
      })
    ).toBeNull();
  });
});
