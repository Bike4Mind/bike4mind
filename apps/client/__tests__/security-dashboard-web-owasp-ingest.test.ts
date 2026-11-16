import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Request, Response } from 'express';

vi.mock('@bike4mind/database', () => ({
  securityDashboardSnapshotRepository: {
    create: vi.fn().mockResolvedValue({ id: 'snapshot-id' }),
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

vi.mock('@bike4mind/server-utils/security/securityDashboardScoring', () => ({
  computeWebsiteScore: vi.fn().mockReturnValue(80),
  computeDeterministicStatus: vi.fn().mockReturnValue('warn'),
}));

vi.mock('sst', () => ({
  Resource: {},
}));

const mockSqsSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return { send: mockSqsSend };
  }),
  SendMessageCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));

vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn().mockReturnValue('https://sqs.us-east-1.amazonaws.com/123456789/secopsTriageQueue'),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

import handler from '../pages/api/admin/security-dashboard/web-owasp-ingest';

const HIGH_ALERT = {
  id: '10038',
  title: 'Content Security Policy Header Not Set',
  severity: 'high',
  description: '<p>CSP is not set.</p>',
  recommendation: '<p>Set the header.</p>',
  instances: [{ uri: 'https://app.example.com/', param: '' }],
};

const LOW_ALERT = {
  id: '10021',
  title: 'X-Content-Type-Options Header Missing',
  severity: 'low',
  description: 'Header missing.',
  instances: [{ uri: 'https://app.example.com/login' }],
};

describe('web-owasp-ingest API', () => {
  const createMockReqRes = (body: Record<string, unknown>) => {
    const req = {
      url: '/api/admin/security-dashboard/web-owasp-ingest',
      method: 'POST',
      logger: { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      connection: { remoteAddress: '127.0.0.1' },
      headers: { 'x-security-ingest-token': 'test-ingest-token' },
      body: {
        stage: 'dev',
        targetUrl: 'https://app.example.com',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        ...body,
      },
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    return { req, res };
  };

  const publishedBody = () => {
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [sentCommand] = mockSqsSend.mock.calls[0];
    return JSON.parse((sentCommand as { MessageBody: string }).MessageBody);
  };

  beforeEach(() => {
    process.env.SECOPS_ZAP_INGEST_TOKEN = 'test-ingest-token';
    vi.clearAllMocks();
    mockSqsSend.mockResolvedValue({});
  });

  it('publishes findingsComplete true when the alert list matches the counts', async () => {
    const { req, res } = createMockReqRes({
      counts: { critical: 0, high: 1, medium: 0, low: 1 },
      alerts: [HIGH_ALERT, LOW_ALERT],
    });

    await handler(req, res);

    const body = publishedBody();
    expect(body.scanSource).toBe('web-owasp');
    expect(body.findingsComplete).toBe(true);
    expect(body.findings).toHaveLength(2);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('publishes findingsComplete true for a clean scan with zero counts and an empty alert list', async () => {
    const { req, res } = createMockReqRes({
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      alerts: [],
    });

    await handler(req, res);

    expect(publishedBody().findingsComplete).toBe(true);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('publishes findingsComplete false when counts are reported without an alert list', async () => {
    const { req, res } = createMockReqRes({
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
    });

    await handler(req, res);

    const body = publishedBody();
    expect(body.findingsComplete).toBe(false);
    expect(body.findings).toEqual([]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('publishes findingsComplete false when the alert list is shorter than the counts', async () => {
    const { req, res } = createMockReqRes({
      counts: { critical: 0, high: 2, medium: 1, low: 1 },
      alerts: [HIGH_ALERT, LOW_ALERT],
    });

    await handler(req, res);

    const body = publishedBody();
    expect(body.findingsComplete).toBe(false);
    expect(body.findings).toHaveLength(2);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('publishes findingsComplete false when the alert list is longer than the counts', async () => {
    const { req, res } = createMockReqRes({
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      alerts: [HIGH_ALERT, LOW_ALERT],
    });

    await handler(req, res);

    expect(publishedBody().findingsComplete).toBe(false);
  });
});
