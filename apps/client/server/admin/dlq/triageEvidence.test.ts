import { describe, expect, it, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn(), logs: vi.fn() }));
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send = h.send;
  },
  FilterLogEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', () => ({
  resolveConsumerLogs: h.logs,
  settleWithinBudget: (values: Promise<unknown>[]) => Promise.all(values),
  messageLogWindow: (sent: number) => (Number.isFinite(sent) ? { start: sent, end: sent + 1000 } : null),
}));
import { buildDlqTriageEvidence, sampleDlqConsumerLogs } from './triageEvidence';

const now = Date.parse('2026-11-17T12:00:00Z');
const base = { now, logFallback: { status: 'unavailable' as const, sampledEvents: 0 } };
beforeEach(() => vi.resetAllMocks());
describe('privacy-safe triage evidence', () => {
  it('keeps unavailable evidence unknown, including mutable Lambda versions', () => {
    expect(buildDlqTriageEvidence(base)).toMatchObject({
      coverage: 'partial-sqs-sample',
      failureSource: 'unavailable',
      consumerVersion: 'unknown',
      fixVerification: 'unavailable',
      entityContext: 'unavailable',
      owner: null,
      expiry: { status: 'unavailable' },
    });
  });
  it('explains expiry and identifies the registered owner without asserting a fix', () => {
    expect(
      buildDlqTriageEvidence({
        ...base,
        sentTimestamp: String(now - 86400000),
        retentionSeconds: 2 * 86400,
        owner: 'Accounts',
        entityPresent: true,
      })
    ).toMatchObject({
      expiry: { status: 'within-24-hours', estimatedExpiresAt: '2026-11-18T12:00:00.000Z' },
      owner: 'Accounts',
      fixVerification: 'unavailable',
      entityContext: 'present-id-withheld',
    });
  });
  it.each(['', 'NaN', '-1', String(now + 1)])('does not invent expiry for invalid sent time %s', sentTimestamp => {
    expect(buildDlqTriageEvidence({ ...base, sentTimestamp, retentionSeconds: 86400 }).expiry.status).toBe(
      'unavailable'
    );
  });
  it('does not put arbitrary version strings or error text into issue drafts', () => {
    const evidence = buildDlqTriageEvidence({
      ...base,
      failure: {
        queueLabel: 'private-queue',
        messageId: 'private-id',
        errorType: 'Error',
        errorMessage: 'private user text',
        category: 'bug',
        consumerVersion: '$LATEST private-data',
        failedAt: new Date(now),
      },
    });
    expect(evidence.issueDraft?.body).toContain('version: unknown');
    expect(JSON.stringify(evidence)).not.toMatch(/private|\$LATEST/);
  });
});
describe('bounded consumer log fallback', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  it('retains only a bounded match count, never raw log content or identifiers', async () => {
    h.logs.mockResolvedValue({ region: 'us-east-1', logGroups: ['private-group'], retryWindowMs: 1000 });
    h.send.mockResolvedValue({
      events: [{ message: 'private user text', logStreamName: 'private-stream' }],
      nextToken: 'more',
    });
    expect(await sampleDlqConsumerLogs('https://example.test/source', id, String(now))).toEqual({
      status: 'sampled-matches',
      sampledEvents: 1,
    });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][0].input).toMatchObject({ limit: 20, filterPattern: `"${id}"` });
  });
  it('fails closed for permissions, missing metadata, ambiguous consumers and unsafe filter input', async () => {
    expect(await sampleDlqConsumerLogs('https://example.test/source', 'raw user text', String(now))).toEqual({
      status: 'unavailable',
      sampledEvents: 0,
    });
    expect(h.logs).not.toHaveBeenCalled();
    h.logs.mockResolvedValue({ logGroups: ['one', 'two'] });
    expect((await sampleDlqConsumerLogs('https://example.test/source', id, String(now))).status).toBe('unavailable');
    h.logs.mockResolvedValue({ region: 'us-east-1', logGroups: ['one'], retryWindowMs: 1000 });
    h.send.mockRejectedValue(new Error('AccessDenied'));
    expect((await sampleDlqConsumerLogs('https://example.test/source', id, String(now))).status).toBe('unavailable');
  });
  it('returns unavailable without any lookup once the fallback deadline has passed', async () => {
    expect(await sampleDlqConsumerLogs('https://example.test/source', id, String(now), Date.now() - 1)).toEqual({
      status: 'unavailable',
      sampledEvents: 0,
    });
    expect(h.logs).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});
