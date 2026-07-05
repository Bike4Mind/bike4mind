import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Request, Response } from 'express';

const mockBulkUpsertByFingerprint = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    findings: [{ id: 'f1', severity: 'P1', fingerprint: 'auth::POST /api/auth/login::Rate limit missing on login' }],
    newCount: 1,
    persistingCount: 0,
  })
);
const mockMarkMissingAsResolved = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockFindByRunId = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockCompleteRun = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateRun = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'run-1' }));
const mockSqsSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@bike4mind/database', () => ({
  securityFindingRepository: {
    bulkUpsertByFingerprint: mockBulkUpsertByFingerprint,
    markMissingAsResolved: mockMarkMissingAsResolved,
  },
  securityFindingRunRepository: {
    findByRunId: mockFindByRunId,
    completeRun: mockCompleteRun,
    create: mockCreateRun,
  },
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return { send: mockSqsSend };
  }),
  SendMessageCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn().mockReturnValue('https://sqs.us-east-1.amazonaws.com/123/secopsTriageQueue'),
}));

// Default behavior: tokens match. Individual tests override with mockReturnValueOnce(false)
// to exercise the wrong-token rejection path.
const mockSafeCompareTokens = vi.hoisted(() => vi.fn(() => true));
vi.mock('@bike4mind/auth/crypto', () => ({
  safeCompareTokens: mockSafeCompareTokens,
}));

vi.mock('@bike4mind/common', () => ({
  isPlaceholderValue: vi.fn((v: string | undefined | null) => {
    if (!v) return true;
    const normalized = v.trim().toLowerCase();
    return normalized === 'not-configured' || normalized === 'my-secret-placeholder-value';
  }),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

vi.mock('@server/security/resolveStage', () => ({
  resolveStage: vi.fn(() => 'dev'),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

import handler from '../pages/api/admin/security-dashboard/attack-simulation-ingest';

describe('attack-simulation-ingest API', () => {
  const sampleFinding = {
    fingerprint: 'auth::POST /api/auth/login::Rate limit missing on login',
    category: 'auth' as const,
    severity: 'P1' as const,
    endpoint: 'POST /api/auth/login',
    title: 'Rate limit missing on login',
    details: '20 login attempts succeeded without 429',
    reproduction: 'curl loop with wrong password',
    sourceProbe: 'otcSendFlood',
  };

  const createMockReqRes = (overrides: Partial<Request> = {}) => {
    const req = {
      url: '/api/admin/security-dashboard/attack-simulation-ingest',
      method: 'POST',
      logger: { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      connection: { remoteAddress: '127.0.0.1' },
      headers: { 'x-security-ingest-token': 'test-ingest-token' },
      body: {
        runId: 'run-test-001',
        stage: 'dev',
        trigger: 'scheduled' as const,
        targetUrl: 'https://app.staging.bike4mind.com',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        probesRun: ['otcSendFlood'],
        probeErrors: [],
        findings: [sampleFinding],
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
    process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN = 'test-ingest-token';
    vi.clearAllMocks();
    // vi.clearAllMocks resets the mockReturnValue for safeCompareTokens too - re-establish
    // the "tokens match" default so each test gets a clean slate.
    mockSafeCompareTokens.mockReturnValue(true);
    mockBulkUpsertByFingerprint.mockResolvedValue({
      findings: [{ id: 'f1', severity: 'P1', fingerprint: sampleFinding.fingerprint }],
      newCount: 1,
      persistingCount: 0,
    });
    mockMarkMissingAsResolved.mockResolvedValue(0);
    mockFindByRunId.mockResolvedValue(null);
  });

  it('rejects requests with missing ingest token', async () => {
    const { req, res } = createMockReqRes({ headers: {} as unknown as Request['headers'] });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ingest token.' });
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects requests with a wrong but present ingest token', async () => {
    // Token is supplied in the header but does not match the server's configured value.
    // safeCompareTokens returns false -> handler must reject with 403.
    mockSafeCompareTokens.mockReturnValueOnce(false);
    const { req, res } = createMockReqRes({
      headers: { 'x-security-ingest-token': 'definitely-wrong-token' } as unknown as Request['headers'],
    });

    await handler(req, res);

    expect(mockSafeCompareTokens).toHaveBeenCalledWith('definitely-wrong-token', 'test-ingest-token');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ingest token.' });
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects when ingest token is the not-configured placeholder', async () => {
    process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN = 'not-configured';
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Attack simulation ingest token is not configured.',
    });
  });

  it('rejects when ingest token is the SST default placeholder', async () => {
    process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN = 'my-secret-placeholder-value';
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('rejects payloads missing runId', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, runId: undefined } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects invalid trigger values', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, trigger: 'cron' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects malformed targetUrl', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, targetUrl: 'javascript:alert(1)' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects payloads missing targetUrl', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, targetUrl: undefined } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when probesRun is not an array', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, probesRun: 'oops' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when findings is not an array', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, findings: { not: 'array' } } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when findings exceeds MAX_FINDINGS', async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      ...sampleFinding,
      fingerprint: `auth::POST /api/auth/login::dup-${i}`,
    }));
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, findings: tooMany } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects findings with malformed severity', async () => {
    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        findings: [{ ...sampleFinding, severity: 'critical' }],
      } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBulkUpsertByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects invalid stage values', async () => {
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, stage: 'INVALID STAGE!' } as unknown,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid stage value.' });
  });

  it('accepts an empty findings array and still records the run', async () => {
    mockBulkUpsertByFingerprint.mockResolvedValueOnce({ findings: [], newCount: 0, persistingCount: 0 });
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, findings: [] } as unknown,
    });

    await handler(req, res);

    // Bulk upsert is invoked with an empty list; the repository early-returns.
    expect(mockBulkUpsertByFingerprint).toHaveBeenCalledWith([]);
    expect(mockMarkMissingAsResolved).toHaveBeenCalledWith('dev', 'run-test-001', ['otcSendFlood']);
    expect(mockCreateRun).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('bulk-upserts findings and scopes resolution to executed probes', async () => {
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(mockBulkUpsertByFingerprint).toHaveBeenCalledTimes(1);
    const [calledWith] = mockBulkUpsertByFingerprint.mock.calls[0];
    expect(calledWith).toEqual([
      expect.objectContaining({
        fingerprint: sampleFinding.fingerprint,
        stage: 'dev',
        category: 'auth',
        severity: 'P1',
        runId: 'run-test-001',
        sourceProbe: 'otcSendFlood',
      }),
    ]);
    expect(mockMarkMissingAsResolved).toHaveBeenCalledWith('dev', 'run-test-001', ['otcSendFlood']);
    expect(mockCreateRun).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('persists probeErrors when run is completed', async () => {
    mockFindByRunId.mockResolvedValueOnce({ id: 'existing-run', runId: 'run-test-001' });
    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        probeErrors: ['otcSendFlood: timeout'],
      } as unknown,
    });

    await handler(req, res);

    expect(mockCompleteRun).toHaveBeenCalledWith(
      'run-test-001',
      expect.objectContaining({ new: 1, persisting: 0, resolved: 0 }),
      ['otcSendFlood'],
      ['otcSendFlood: timeout']
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('completes an existing run rather than creating a duplicate', async () => {
    mockFindByRunId.mockResolvedValueOnce({ id: 'existing-run', runId: 'run-test-001' });
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(mockCompleteRun).toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('counts persisting vs new findings correctly', async () => {
    mockBulkUpsertByFingerprint.mockResolvedValueOnce({
      findings: [{ id: 'f-existing', severity: 'P1', fingerprint: sampleFinding.fingerprint }],
      newCount: 0,
      persistingCount: 1,
    });
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        findingCounts: expect.objectContaining({ new: 0, persisting: 1 }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('fans findings out to the SecOps Triage SQS queue with mapped severities', async () => {
    mockBulkUpsertByFingerprint.mockResolvedValueOnce({
      findings: [
        {
          id: 'a',
          severity: 'P0',
          fingerprint: 'authz::GET /api/admin::leak',
          title: 'Admin endpoint accessible without authentication',
          endpoint: 'GET /api/admin',
          details: 'Endpoint returned 200',
          reproduction: 'curl /api/admin',
        },
        {
          id: 'b',
          severity: 'P3',
          fingerprint: 'misc::GET /::low',
          title: 'noise',
          endpoint: 'GET /',
          details: 'd',
          reproduction: 'r',
        },
      ],
      newCount: 2,
      persistingCount: 0,
    });

    const { req, res } = createMockReqRes({
      body: {
        ...createMockReqRes().req.body,
        findings: [
          { ...sampleFinding, fingerprint: 'authz::GET /api/admin::leak', severity: 'P0' },
          { ...sampleFinding, fingerprint: 'misc::GET /::low', severity: 'P3' },
        ],
      } as unknown,
    });

    await handler(req, res);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [sentCommand] = mockSqsSend.mock.calls[0];
    const body = JSON.parse((sentCommand as { MessageBody: string }).MessageBody);
    expect(body.scanSource).toBe('active-defense');
    expect(body.stage).toBe('dev');
    expect(body.snapshotId).toBe('run-test-001');
    expect(body.findings).toHaveLength(2);
    // P0 -> critical, P3 -> low - the mapping at the SecOps boundary
    expect(body.findings[0]).toMatchObject({ id: 'authz::GET /api/admin::leak', severity: 'critical' });
    expect(body.findings[1]).toMatchObject({ id: 'misc::GET /::low', severity: 'low' });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 201 even when SQS publish fails (non-fatal)', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does not publish to SQS when there are no persisted findings', async () => {
    mockBulkUpsertByFingerprint.mockResolvedValueOnce({ findings: [], newCount: 0, persistingCount: 0 });
    const { req, res } = createMockReqRes({
      body: { ...createMockReqRes().req.body, findings: [] } as unknown,
    });

    await handler(req, res);

    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 500 when bulk upsert throws', async () => {
    mockBulkUpsertByFingerprint.mockRejectedValueOnce(new Error('mongo down'));
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to persist findings.' });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });
});
