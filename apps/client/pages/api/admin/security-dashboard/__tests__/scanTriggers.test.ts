// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  axiosPost: vi.fn(),
  invoke: vi.fn(),
  cooldown: vi.fn(),
  functionNames: { cloudSecurityScan: 'cloud-scan-worker' } as Record<string, string>,
  findLatest: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/database', () => ({
  securityDashboardSnapshotRepository: { findLatestByStageAndScanType: h.findLatest },
}));
vi.mock('@bike4mind/server-utils/security/cooldown', () => ({
  getCooldownStatus: h.cooldown,
}));
vi.mock('@bike4mind/server-utils/security/resolveStage', () => ({ resolveStage: () => 'dev' }));
vi.mock('@bike4mind/server-utils/integrations/github/githubWorkflowTrigger', () => ({
  getTargetUrlForStage: () => 'https://example.test',
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue-url' }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = vi.fn();
  },
  SendMessageCommand: class {},
}));
vi.mock('sst', () => ({
  Resource: {
    lambdaFunctionNames: h.functionNames,
    SECOPS_ZAP_DISPATCH_TOKEN: { value: 'test-token' },
    SECOPS_PROWLER_WORKFLOW_TOKEN: { value: 'test-token' },
    GITHUB_ZAP_REF: { value: 'main' },
  },
}));
vi.mock('axios', () => ({ default: { post: h.axiosPost } }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = h.invoke;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

import cloud from '../cloud';
import cloudProwler from '../cloud-prowler';
import web from '../web';

type Route = (req: unknown, res: unknown) => Promise<void>;

const post = async (route: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  (req as Record<string, unknown>).logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  await (route as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.axiosPost.mockResolvedValue({ status: 204 });
  h.invoke.mockResolvedValue({ StatusCode: 202 });
  h.cooldown.mockReturnValue({ canRun: true, hoursRemaining: 0 });
  h.functionNames.cloudSecurityScan = 'cloud-scan-worker';
  h.findLatest.mockResolvedValue(null);
});

describe('admin security scan triggers audit', () => {
  it.each([
    ['cloud', cloud, 202, h.invoke],
    ['cloud-prowler', cloudProwler, 202, h.axiosPost],
    ['web', web, 202, h.axiosPost],
  ])('records settings.security_scan.triggered for a %s scan', async (scanType, route, status, effect) => {
    const { req, res } = await post(route);

    expect(res._getStatusCode()).toBe(status);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.security_scan.triggered',
      target: { kind: 'system', id: `security-scan:${scanType}` },
      details: { scanType, stage: 'dev' },
    });
    expect(effect.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not record a trigger when the workflow dispatch fails', async () => {
    h.axiosPost.mockRejectedValue(new Error('dispatch failed'));

    const { res } = await post(web);

    expect(res._getStatusCode()).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not record a trigger when Lambda dispatch fails', async () => {
    h.invoke.mockRejectedValue(new Error('dispatch failed'));

    const { res } = await post(cloud);

    expect(res._getStatusCode()).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('queues the manual worker payload and returns without reading a result snapshot', async () => {
    const { res } = await post(cloud);
    expect(res._getJSONData()).toEqual({ canRun: true, queued: true });
    expect(h.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          FunctionName: 'cloud-scan-worker',
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })),
        },
      })
    );
    expect(h.findLatest).toHaveBeenCalledExactlyOnceWith('dev', 'cloud');
  });

  it('preserves the cooldown without dispatching or auditing', async () => {
    const checkedAt = new Date();
    h.findLatest.mockResolvedValue({ checkedAt });
    h.cooldown.mockReturnValue({ canRun: false, hoursRemaining: 12 });
    const { res } = await post(cloud);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).toEqual({ canRun: false, reason: 'cooldown', hoursRemaining: 12 });
    expect(h.cooldown).toHaveBeenCalledWith(checkedAt);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('fails without auditing when the worker is not linked', async () => {
    delete h.functionNames.cloudSecurityScan;
    const { res } = await post(cloud);
    expect(res._getStatusCode()).toBe(500);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('rejects a non-admin before dispatch', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    (req as Record<string, unknown>).user = { id: 'user-1', isAdmin: false };
    await expect((cloud as unknown as Route)(req, res)).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
