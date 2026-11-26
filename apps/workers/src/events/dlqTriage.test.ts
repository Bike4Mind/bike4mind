import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cloudwatch: vi.fn(),
  sqs: vi.fn(),
  connect: vi.fn(),
  config: vi.fn(),
  triage: vi.fn(),
  claim: vi.fn(),
  delivered: vi.fn(),
  release: vi.fn(),
  logs: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = h.cloudwatch;
  },
  DescribeAlarmsCommand: class {},
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = h.sqs;
  },
  GetQueueUrlCommand: class {},
  ListDeadLetterSourceQueuesCommand: class {},
  GetQueueAttributesCommand: class {},
  ReceiveMessageCommand: class {},
}));
vi.mock('@bike4mind/db-core', () => ({ connectDB: h.connect }));
vi.mock('@bike4mind/database', () => ({
  loadKeyringInBackground: vi.fn(),
  dlqTriageDeliveryRepository: { claim: h.claim, delivered: h.delivered, release: h.release },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => ({ label: 'fixture' }),
  describeDlqMessage: () => null,
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', () => ({
  resolveConsumerLogs: h.logs,
  settleWithinBudget: (values: Promise<unknown>[], budgetMs: number) =>
    Promise.all(
      values.map(value => Promise.race([value, new Promise(resolve => setTimeout(() => resolve(null), budgetMs))]))
    ),
}));
vi.mock('@bike4mind/server-utils/admin/dlq/triage', () => ({
  triageDlqMessage: h.triage,
  loadDlqTriageConfig: h.config,
}));
vi.mock('sst', () => ({ Resource: { App: { name: 'app', stage: 'test' }, MONGODB_URI: { value: 'fixture' } } }));

import { collectDlqTriage, canNotifyDlqTriage, finishDlqTriageDelivery } from './dlqTriage';

beforeEach(() => {
  vi.resetAllMocks();
  h.config.mockResolvedValue({ enabled: true, features: { dlqTriage: { mode: 'recommend' } }, dlqQueueModes: {} });
  h.cloudwatch.mockResolvedValue({ MetricAlarms: [{ Dimensions: [{ Name: 'QueueName', Value: 'fixture' }] }] });
  h.sqs
    .mockResolvedValueOnce({ QueueUrl: 'https://example.test/dlq' })
    .mockResolvedValueOnce({ queueUrls: ['https://example.test/source'] })
    .mockResolvedValueOnce({ Attributes: { MessageRetentionPeriod: '1209600', ApproximateNumberOfMessages: '100' } })
    .mockResolvedValueOnce({ Messages: Array.from({ length: 10 }, (_, i) => ({ MessageId: `message-${i}` })) })
    .mockResolvedValue({ Messages: [] });
  h.triage.mockImplementation(async (_queue, messageId) => ({
    id: messageId,
    entityId: `fixture:${messageId}`,
    status: 'pending',
    verdict: 'investigate',
    actionClass: 'review-required',
    reasons: [{ text: 'Inspect the recorded failure before acting. '.repeat(4) }],
  }));
  h.claim.mockResolvedValue(true);
});

describe('DLQ triage collection', () => {
  it('warms the consumer-log cache once and bounds per-message log fallbacks inside the run deadline', async () => {
    h.logs.mockResolvedValue(null);
    const runDeadline = Date.now() + 10_000;
    await collectDlqTriage('app-test-dlq-fixture-messages', undefined, runDeadline);
    expect(h.logs).toHaveBeenCalledTimes(1);
    expect(h.logs).toHaveBeenCalledWith('https://example.test/source');
    expect(h.triage).toHaveBeenCalledTimes(10);
    for (const call of h.triage.mock.calls) {
      expect(call[2].logFallbackDeadline).toEqual(expect.any(Number));
      expect(call[2].logFallbackDeadline).toBeLessThanOrEqual(runDeadline);
    }
  });
  it('finishes collection when the consumer-log lookup never resolves', async () => {
    vi.useFakeTimers();
    try {
      h.logs.mockReturnValue(new Promise(() => {}));
      const pending = collectDlqTriage('app-test-dlq-fixture-messages');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).not.toBeNull();
      expect(h.triage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds Slack content before claiming and explicitly reports partial sampling', async () => {
    const result = await collectDlqTriage('app-test-dlq-fixture-messages', 'https://example.test');
    expect(result?.section).toContain('Sampled 10 unique messages');
    expect(result?.section).toContain('Partial coverage');
    expect(result!.section.length).toBeLessThan(3_000);
    expect(result!.suggestionIds.length).toBeGreaterThan(0);
    expect(result!.suggestionIds.length).toBeLessThan(10);
    expect(h.claim).toHaveBeenCalledTimes(result!.suggestionIds.length);
  });
  it('does not repost suggestions already claimed by the other trigger', async () => {
    h.claim.mockResolvedValue(false);
    expect(await collectDlqTriage('app-test-dlq-fixture-age')).toBeNull();
  });
  it.each(['accepted', 'dismissed'])('does not claim another Slack approval for %s suggestions', async status => {
    h.triage.mockResolvedValue({ id: 'decided-suggestion', status });
    expect(await collectDlqTriage('app-test-dlq-fixture-messages')).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
  });
  it('rechecks off switches immediately before notification and fails closed', async () => {
    h.config.mockResolvedValueOnce({
      enabled: false,
      features: { dlqTriage: { mode: 'recommend' } },
      dlqQueueModes: {},
    });
    expect(await canNotifyDlqTriage({ queueLabel: 'fixture', suggestionIds: ['one'] })).toBe(false);
    expect(h.release).toHaveBeenCalledWith('dlq-suggestion:one');
    h.config.mockResolvedValueOnce({
      enabled: true,
      features: { dlqTriage: { mode: 'recommend' } },
      dlqQueueModes: { fixture: 'off' },
    });
    expect(await canNotifyDlqTriage({ queueLabel: 'fixture', suggestionIds: [] })).toBe(false);
    h.config.mockRejectedValueOnce(new Error('unavailable'));
    expect(await canNotifyDlqTriage({ queueLabel: 'fixture', suggestionIds: [] })).toBe(false);
  });
  it('releases acquired claims if a later claim fails before sending', async () => {
    h.claim.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(collectDlqTriage('app-test-dlq-fixture-age')).rejects.toThrow('database unavailable');
    expect(h.release).toHaveBeenCalledWith('dlq-suggestion:message-0');
  });
  it('releases a claim that completes after the collection deadline', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    h.claim.mockImplementationOnce(async () => {
      clock.mockReturnValue(now + 16_000);
      return true;
    });
    try {
      expect(await collectDlqTriage('app-test-dlq-fixture-age')).toBeNull();
      expect(h.release).toHaveBeenCalledWith('dlq-suggestion:message-0');
    } finally {
      clock.mockRestore();
    }
  });
  it('checks the switch before acquiring any claims', async () => {
    h.config
      .mockResolvedValueOnce({ enabled: true, features: { dlqTriage: { mode: 'recommend' } }, dlqQueueModes: {} })
      .mockResolvedValue({ enabled: false, features: { dlqTriage: { mode: 'recommend' } }, dlqQueueModes: {} });
    expect(await collectDlqTriage('app-test-dlq-fixture-age')).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
  });
  it('does not call AWS after an expired run budget', async () => {
    await expect(collectDlqTriage('app-test-dlq-fixture-age', undefined, Date.now() - 1)).rejects.toThrow('deadline');
    expect(h.sqs).not.toHaveBeenCalled();
  });
  it('leaves ambiguous deliveries unconfirmed', async () => {
    await finishDlqTriageDelivery({ key: 'batch', suggestionIds: ['one'] }, false);
    expect(h.delivered).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});
