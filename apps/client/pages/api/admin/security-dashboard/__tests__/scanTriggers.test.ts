// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  axiosPost: vi.fn(),
  runCloudScan: vi.fn(),
  runWafScan: vi.fn(),
  findLatest: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/database', () => ({
  securityDashboardSnapshotRepository: { findLatestByStageAndScanType: h.findLatest },
}));
vi.mock('@bike4mind/server-utils/security/cooldown', () => ({
  getCooldownStatus: () => ({ canRun: true, hoursRemaining: 0 }),
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
    SECOPS_ZAP_DISPATCH_TOKEN: { value: 'test-token' },
    SECOPS_PACKAGES_DISPATCH_TOKEN: { value: 'test-token' },
    SECOPS_SECRETS_DISPATCH_TOKEN: { value: 'test-token' },
    SECOPS_PROWLER_WORKFLOW_TOKEN: { value: 'test-token' },
    GITHUB_ZAP_REF: { value: 'main' },
  },
}));
vi.mock('axios', () => ({ default: { post: h.axiosPost } }));
vi.mock('@server/security/cloudScan', () => ({ handler: h.runCloudScan }));
vi.mock('@server/security/wafScan', () => ({ handler: h.runWafScan }));

import cloud from '../cloud';
import cloudProwler from '../cloud-prowler';
import code from '../code';
import packages from '../packages';
import secrets from '../secrets';
import waf from '../waf';
import web from '../web';

type Route = (req: unknown, res: unknown) => Promise<void>;

const post = async (route: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (route as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.axiosPost.mockResolvedValue({ status: 204 });
  h.runCloudScan.mockResolvedValue(undefined);
  h.runWafScan.mockResolvedValue(undefined);
  h.findLatest.mockResolvedValue(null);
});

describe('admin security scan triggers audit', () => {
  it.each([
    ['cloud', cloud, 202, h.runCloudScan],
    ['cloud-prowler', cloudProwler, 202, h.axiosPost],
    ['code', code, 202, h.axiosPost],
    ['packages', packages, 202, h.axiosPost],
    ['secrets', secrets, 202, h.axiosPost],
    ['waf', waf, 200, h.runWafScan],
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

    const { res } = await post(code);

    expect(res._getStatusCode()).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not record a trigger when an inline scan fails', async () => {
    h.runWafScan.mockRejectedValue(new Error('scan failed'));

    const { res } = await post(waf);

    expect(res._getStatusCode()).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
