import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ scan: vi.fn(), send: vi.fn(), error: vi.fn() }));
vi.mock('@bike4mind/server-utils/security/cloudScan', () => ({ handler: h.scan }));
vi.mock('sst', () => ({ Resource: { secopsTriageQueue: { url: 'triage-queue' } } }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = h.send;
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: h.error } }));

import { handler } from './cloudScan';

const findings = ['critical', 'high', 'medium', 'low'].map(severity => ({
  id: severity,
  title: `${severity} finding`,
  severity,
  description: 'description',
  recommendation: 'recommendation',
  documentationUrl: 'https://example.test',
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.scan.mockResolvedValue({ id: 'snapshot-1', stage: 'dev', findings });
  h.send.mockResolvedValue({});
});

describe('cloud scan worker', () => {
  it('fans out only critical/high findings from the completed manual scan', async () => {
    await handler({ trigger: 'manual' });
    expect(h.scan).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledOnce();
    const message = h.send.mock.calls[0][0].input;
    expect(message.QueueUrl).toBe('triage-queue');
    expect(JSON.parse(message.MessageBody)).toEqual({
      stage: 'dev',
      scanSource: 'cloud',
      snapshotId: 'snapshot-1',
      targetUrl: 'aws:cloud-infrastructure',
      findings: findings.slice(0, 2).map(f => ({ ...f, instances: [] })),
    });
    expect(h.scan.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]);
  });

  it.each([undefined, {}, { trigger: 'scheduled' }])('preserves scheduled scan behavior for %j', async event => {
    await handler(event);
    expect(h.scan).toHaveBeenCalledOnce();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not publish scans without critical/high findings', async () => {
    h.scan.mockResolvedValue({ findings: findings.slice(2) });
    await handler({ trigger: 'manual' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('propagates scan failures for async failure handling', async () => {
    h.scan.mockRejectedValue(new Error('scan failed'));
    await expect(handler({ trigger: 'manual' })).rejects.toThrow('scan failed');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('keeps triage publication best-effort', async () => {
    h.send.mockRejectedValue(new Error('queue unavailable'));
    await expect(handler({ trigger: 'manual' })).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining('non-fatal'), { error: 'queue unavailable' });
  });
});
