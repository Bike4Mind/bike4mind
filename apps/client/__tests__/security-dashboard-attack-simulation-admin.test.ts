import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// Shared mocks (apply to both endpoint tests)

const mockFindRecentByStage = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockFindActiveByStage = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockFindLastTerminalRun = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('@bike4mind/database', () => ({
  securityFindingRepository: {
    findActiveByStage: mockFindActiveByStage,
  },
  securityFindingRunRepository: {
    findRecentByStage: mockFindRecentByStage,
    findLastTerminalRun: mockFindLastTerminalRun,
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
    post: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

vi.mock('sst', () => ({
  Resource: {
    App: { stage: 'dev' },
    lambdaFunctionNames: { attackSimulation: 'dev-attack-sim-fn' },
  },
}));

const mockLambdaSend = vi.hoisted(() => vi.fn().mockResolvedValue({ StatusCode: 202 }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: mockLambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));

const mockLogAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: mockLogAudit,
  AdminConfigAuditEvents: { SECURITY_SCAN_SCHEDULE_TRIGGERED: 'SECURITY_SCAN_SCHEDULE_TRIGGERED' },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

import getHandler from '../pages/api/admin/security-dashboard/attack-simulation';
import postHandler from '../pages/api/admin/security-dashboard/run-attack-simulation';

const adminUser = { id: 'admin-1', isAdmin: true } as { id: string; isAdmin: boolean };
const nonAdminUser = { id: 'user-1', isAdmin: false } as { id: string; isAdmin: boolean };

const makeRes = () => {
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;
  return { res, json };
};

describe('GET /api/admin/security-dashboard/attack-simulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindRecentByStage.mockResolvedValue([]);
    mockFindActiveByStage.mockResolvedValue([]);
  });

  it('rejects non-admin users with ForbiddenError', async () => {
    const req = { user: nonAdminUser } as unknown as Request;
    const { res } = makeRes();
    await expect(getHandler(req, res)).rejects.toThrow(/admin access required/i);
    expect(mockFindRecentByStage).not.toHaveBeenCalled();
  });

  it('rejects requests with no user with ForbiddenError', async () => {
    const req = {} as unknown as Request;
    const { res } = makeRes();
    await expect(getHandler(req, res)).rejects.toThrow(/admin access required/i);
  });

  it('returns runs and findings for admin users', async () => {
    const sampleRun = { runId: 'r1', stage: 'dev', status: 'completed', startedAt: new Date() };
    const sampleFinding = { fingerprint: 'auth::POST /::leak', severity: 'P1', stage: 'dev' };
    mockFindRecentByStage.mockResolvedValue([sampleRun]);
    mockFindActiveByStage.mockResolvedValue([sampleFinding]);

    const req = { user: adminUser } as unknown as Request;
    const { res, json } = makeRes();
    await getHandler(req, res);

    expect(mockFindRecentByStage).toHaveBeenCalledWith('dev', 10);
    expect(mockFindActiveByStage).toHaveBeenCalledWith('dev');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      stage: 'dev',
      runs: [sampleRun],
      findings: [sampleFinding],
    });
  });
});

describe('POST /api/admin/security-dashboard/run-attack-simulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindLastTerminalRun.mockResolvedValue(null);
    mockLambdaSend.mockResolvedValue({ StatusCode: 202 });
  });

  it('rejects non-admin users with ForbiddenError', async () => {
    const req = { user: nonAdminUser } as unknown as Request;
    const { res } = makeRes();
    await expect(postHandler(req, res)).rejects.toThrow(/admin access required/i);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('rejects when cooldown is active', async () => {
    // Last terminal run started 5 minutes ago; cooldown is 30 min, so 25 remaining.
    mockFindLastTerminalRun.mockResolvedValue({
      runId: 'recent',
      stage: 'dev',
      status: 'completed',
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const req = {
      user: adminUser,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Request;
    const { res } = makeRes();
    await expect(postHandler(req, res)).rejects.toThrow(/cooldown active/i);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('allows a run when last terminal run is older than the cooldown window', async () => {
    mockFindLastTerminalRun.mockResolvedValue({
      runId: 'old',
      stage: 'dev',
      status: 'completed',
      startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    });
    const req = {
      user: adminUser,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Request;
    const { res, json } = makeRes();
    await postHandler(req, res);

    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ queued: true, runId: expect.any(String) }));
  });

  it('emits a SECURITY_SCAN_SCHEDULE_TRIGGERED audit event', async () => {
    const req = {
      user: adminUser,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Request;
    const { res } = makeRes();
    await postHandler(req, res);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'SECURITY_SCAN_SCHEDULE_TRIGGERED',
        metadata: expect.objectContaining({
          scanType: 'attack-simulation',
          stage: 'dev',
          trigger: 'manual',
        }),
      }),
      expect.anything()
    );
  });

  // Restoring the mocked Resource via try/finally is fragile: if postHandler throws, the
  // assertions inside the try block silently never execute. A nested describe with
  // beforeEach/afterEach guarantees the mock state is restored regardless of test outcome
  // and keeps the assertions out of any try block.
  describe('when lambdaFunctionNames is not linked', () => {
    let originalResource: unknown;

    beforeEach(async () => {
      const sst = await import('sst');
      const ref = sst.Resource as unknown as { lambdaFunctionNames: unknown };
      originalResource = ref.lambdaFunctionNames;
      ref.lambdaFunctionNames = undefined;
    });

    afterEach(async () => {
      const sst = await import('sst');
      (sst.Resource as unknown as { lambdaFunctionNames: unknown }).lambdaFunctionNames = originalResource;
    });

    it('returns 500 without invoking the Lambda', async () => {
      const req = {
        user: adminUser,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as unknown as Request;
      const { res, json } = makeRes();

      await postHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Attack simulation function is not configured.' });
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });
});
