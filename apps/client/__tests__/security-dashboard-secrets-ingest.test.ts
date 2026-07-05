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

import handler from '../pages/api/admin/security-dashboard/secrets-ingest';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';

describe('secrets-ingest API', () => {
  const createMockReqRes = (overrides: Partial<Request> = {}) => {
    const req = {
      // next-connect expects url and method to be defined on the request
      url: '/api/admin/security-dashboard/secrets-ingest',
      method: 'POST',
      // Minimal logger and connection shape to satisfy any logging usage
      logger: {
        log: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      connection: {
        remoteAddress: '127.0.0.1',
      },
      headers: { 'x-security-ingest-token': 'test-ingest-token' },
      body: {
        stage: 'dev',
        tool: 'gitleaks',
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
        alerts: [
          {
            id: 'leak-1',
            secretType: 'apiKey',
            severity: 'critical',
            filePath: 'src/index.ts',
            line: 42,
            description: 'AWS key in source file',
          },
        ],
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
    // Ensure ingest token is configured via environment for each test run
    process.env.SECOPS_SECRETS_INGEST_TOKEN = 'test-ingest-token';
    vi.clearAllMocks();
    mockSqsSend.mockResolvedValue({});
  });

  it('rejects requests with missing ingest token', async () => {
    const { req, res } = createMockReqRes({ headers: {} as any });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ingest token.' });
    expect(securityDashboardSnapshotRepository.create).not.toHaveBeenCalled();
  });

  it('rejects invalid stage values', async () => {
    const { req, res } = createMockReqRes({ body: { ...createMockReqRes().req.body, stage: 'INVALID STAGE!' } as any });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid stage value.' });
    expect(securityDashboardSnapshotRepository.create).not.toHaveBeenCalled();
  });

  it('creates a secrets snapshot when payload and token are valid', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(securityDashboardSnapshotRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'dev',
        scanType: 'secrets',
        status: 'fail',
        findings: expect.arrayContaining([
          expect.objectContaining({
            id: 'leak-1',
            title: expect.stringContaining('apiKey'),
          }),
        ]),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('publishes findings to SecOps Triage SQS queue after successful ingest', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [sentCommand] = mockSqsSend.mock.calls[0];
    const body = JSON.parse((sentCommand as { MessageBody: string }).MessageBody);

    expect(body.scanSource).toBe('secrets');
    expect(body.stage).toBe('dev');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      id: 'leak-1',
      title: 'apiKey exposure',
      severity: 'critical',
      instances: [],
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 201 even when SQS publish fails', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
