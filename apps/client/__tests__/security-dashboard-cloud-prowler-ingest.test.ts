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

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

vi.mock('@server/security/securityDashboardScoring', () => ({
  computeStatusScoreAndSummary: vi.fn().mockReturnValue({
    status: 'fail',
    score: 60,
    summary: 'Prowler found critical findings.',
  }),
}));

vi.mock('@server/security/resolveStage', () => ({
  resolveStage: vi.fn(() => 'dev'),
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

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn().mockReturnValue('https://sqs.us-east-1.amazonaws.com/123456789/secopsTriageQueue'),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

import handler from '../pages/api/admin/security-dashboard/cloud-prowler-ingest';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';

const FAIL_CRITICAL: object = {
  id: 'iam-root-mfa',
  title: 'Root account MFA not enabled',
  severity: 'critical',
  status: 'FAIL',
  description: 'Root account has no MFA.',
  recommendation: 'Enable MFA on root.',
  documentationUrl: 'https://docs.aws.amazon.com/iam/mfa',
  region: 'us-east-1',
  resourceArn: 'arn:aws:iam::123456789:root',
};

const PASS_FINDING: object = {
  id: 'cloudtrail-enabled',
  title: 'CloudTrail multi-region enabled',
  severity: 'critical',
  status: 'PASS',
};

describe('cloud-prowler-ingest API', () => {
  const createMockReqRes = (overrides: Partial<Request> = {}) => {
    const req = {
      url: '/api/admin/security-dashboard/cloud-prowler-ingest',
      method: 'POST',
      logger: { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      connection: { remoteAddress: '127.0.0.1' },
      headers: { 'x-security-ingest-token': 'test-ingest-token' },
      body: {
        stage: 'dev',
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
        findings: [FAIL_CRITICAL],
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
    process.env.SECOPS_PROWLER_INGEST_TOKEN = 'test-ingest-token';
    vi.clearAllMocks();
    mockSqsSend.mockResolvedValue({});
    vi.mocked(securityDashboardSnapshotRepository.create).mockResolvedValue({ id: 'snapshot-id' } as never);
  });

  it('rejects requests with missing ingest token', async () => {
    const { req, res } = createMockReqRes({ headers: {} as unknown as Request['headers'] });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ingest token.' });
    expect(securityDashboardSnapshotRepository.create).not.toHaveBeenCalled();
  });

  it('returns 500 when ingest token is not configured', async () => {
    process.env.SECOPS_PROWLER_INGEST_TOKEN = 'my-secret-placeholder-value';
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Prowler ingest token is not configured.' });
  });

  it('returns 400 when counts is missing', async () => {
    const { req, res } = createMockReqRes({
      body: { findings: [FAIL_CRITICAL] } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid payload: counts and findings are required.' });
  });

  it('returns 400 when findings is not an array', async () => {
    const { req, res } = createMockReqRes({
      body: { counts: { critical: 1, high: 0, medium: 0, low: 0 }, findings: 'bad' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid payload: counts and findings are required.' });
  });

  it('returns 400 for invalid stage value', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, stage: 'INVALID STAGE!' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid stage value.' });
  });

  it('falls back to resolveStage() when stage is omitted from the body', async () => {
    const bodyWithoutStage = {
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      findings: [FAIL_CRITICAL],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const { req, res } = createMockReqRes({ body: bodyWithoutStage as unknown as Request['body'] });

    await handler(req, res);

    expect(securityDashboardSnapshotRepository.create).toHaveBeenCalledWith(expect.objectContaining({ stage: 'dev' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('creates a snapshot and returns 201 on valid payload', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(securityDashboardSnapshotRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'dev',
        scanType: 'cloud-prowler',
        targetUrl: 'aws:cloud-infrastructure',
        findings: expect.arrayContaining([
          expect.objectContaining({
            id: 'iam-root-mfa',
            severity: 'critical',
            metadata: expect.objectContaining({ region: 'us-east-1' }),
          }),
        ]),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('filters out PASS findings — only FAIL findings are stored', async () => {
    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        findings: [FAIL_CRITICAL, PASS_FINDING],
      } as unknown,
    });

    await handler(req, res);

    const createCall = vi.mocked(securityDashboardSnapshotRepository.create).mock.calls[0][0];
    expect(createCall.findings).toHaveLength(1);
    expect(createCall.findings[0].id).toBe('iam-root-mfa');
  });

  it('publishes critical/high FAIL findings to SecOps Triage SQS', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [sentCommand] = mockSqsSend.mock.calls[0];
    const body = JSON.parse((sentCommand as { MessageBody: string }).MessageBody);

    expect(body.scanSource).toBe('cloud');
    expect(body.stage).toBe('dev');
    expect(body.snapshotId).toBe('snapshot-id');
    expect(body.targetUrl).toBe('aws:cloud-infrastructure');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      id: 'iam-root-mfa',
      severity: 'critical',
      instances: [],
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does not publish to SQS when all FAIL findings are medium/low severity', async () => {
    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        findings: [{ id: 'low-1', title: 'Low finding', severity: 'low', status: 'FAIL' }],
      } as unknown,
    });

    await handler(req, res);

    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does not publish to SQS when findings array is empty (all PASS)', async () => {
    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        findings: [PASS_FINDING],
      } as unknown,
    });

    await handler(req, res);

    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 201 even when SQS publish fails', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
