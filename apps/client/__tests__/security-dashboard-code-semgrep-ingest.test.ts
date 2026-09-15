import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Request, Response } from 'express';

vi.mock('@bike4mind/database', () => ({
  securityDashboardSnapshotRepository: {
    create: vi.fn().mockResolvedValue({ id: 'snapshot-id' }),
  },
}));

vi.mock('@bike4mind/services/utils/crypto', () => ({
  safeCompareTokens: vi.fn(() => true),
}));

// Simplify baseApi for this test to avoid full middleware chain (logging, DB, auth)
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

// vi.hoisted ensures mockSqsSend is initialized before vi.mock factories run (which are hoisted)
const mockSqsSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return { send: mockSqsSend };
  }),
  SendMessageCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn().mockReturnValue('https://sqs.us-east-1.amazonaws.com/123456789/secopsTriageQueue'),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

import handler from '../pages/api/admin/security-dashboard/code-semgrep-ingest';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';

describe('code-semgrep-ingest API', () => {
  const makeAlert = (id: string, severity: 'low' | 'medium' | 'high' | 'critical') => ({
    id,
    title: `Finding ${id}`,
    severity,
    filePath: 'src/app.ts',
    line: 10,
  });

  const createMockReqRes = (overrides: Partial<Request> = {}) => {
    const req = {
      url: '/api/admin/security-dashboard/code-semgrep-ingest',
      method: 'POST',
      logger: { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      connection: { remoteAddress: '127.0.0.1' },
      headers: { 'x-security-ingest-token': 'test-ingest-token' },
      body: {
        stage: 'dev',
        tool: 'semgrep',
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
        alerts: [makeAlert('semgrep-1', 'critical')],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      ...overrides,
    } as unknown as Request;

    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json,
    } as unknown as Response;

    return { req, res, json };
  };

  beforeEach(() => {
    process.env.SECOPS_CODE_INGEST_TOKEN = 'test-ingest-token';
    vi.clearAllMocks();
    mockSqsSend.mockResolvedValue({});
  });

  it('rejects requests with missing ingest token', async () => {
    const { req, res } = createMockReqRes({ headers: {} as unknown as Request['headers'] });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ingest token.' });
    expect(securityDashboardSnapshotRepository.create).not.toHaveBeenCalled();
  });

  it('rejects invalid stage values', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, stage: 'INVALID STAGE!' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid stage value.' });
    expect(securityDashboardSnapshotRepository.create).not.toHaveBeenCalled();
  });

  it('creates a code-semgrep snapshot when payload and token are valid', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(securityDashboardSnapshotRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'dev',
        scanType: 'code-semgrep',
        findings: expect.arrayContaining([expect.objectContaining({ id: 'semgrep-1' })]),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does NOT publish to SQS when all findings are medium or low severity', async () => {
    const { req, res } = createMockReqRes({
      body: {
        stage: 'dev',
        tool: 'semgrep',
        counts: { critical: 0, high: 0, medium: 2, low: 1 },
        alerts: [makeAlert('med-1', 'medium'), makeAlert('med-2', 'medium'), makeAlert('low-1', 'low')],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('publishes only critical and high findings to SQS, filtering out medium/low', async () => {
    const { req, res } = createMockReqRes({
      body: {
        stage: 'dev',
        tool: 'semgrep',
        counts: { critical: 1, high: 1, medium: 1, low: 1 },
        alerts: [
          makeAlert('crit-1', 'critical'),
          makeAlert('high-1', 'high'),
          makeAlert('med-1', 'medium'),
          makeAlert('low-1', 'low'),
        ],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } as unknown,
    });

    await handler(req, res);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [sentCommand] = mockSqsSend.mock.calls[0];
    const body = JSON.parse((sentCommand as { MessageBody: string }).MessageBody);

    expect(body.scanSource).toBe('code-semgrep');
    expect(body.stage).toBe('dev');
    expect(body.findings).toHaveLength(2);
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(['crit-1', 'high-1']));
    expect(body.findings.map((f: { id: string }) => f.id)).not.toContain('med-1');
    expect(body.findings.map((f: { id: string }) => f.id)).not.toContain('low-1');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 201 even when SQS publish fails', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
