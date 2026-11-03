// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  listIssues: vi.fn(),
  getIssue: vi.fn(),
  dispatch: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain: Record<string, unknown> = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Route) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SreAgentConfigSchema: { parse: (value: unknown) => value },
  getConfiguredRepoSlugs: () => ['acme/app'],
  resolveFullConfig: vi.fn(() => ({
    enabled: true,
    sources: { github: { enabled: true, labelFilter: { required: ['sre'] } } },
  })),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue({}) },
  sreErrorTrackingRepository: {
    findLatestByFingerprintBatch: vi.fn().mockResolvedValue(new Map()),
    countFixesDispatchedToday: vi.fn().mockResolvedValue(0),
    deleteTerminalByFingerprint: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  },
  cacheRepository: {
    claimDedup: vi.fn().mockResolvedValue({ claimed: true }),
    deleteByKey: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@bike4mind/database/infra', () => ({ classifyForScan: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({
  GitHubService: { forSystem: vi.fn().mockResolvedValue({ listIssues: h.listIssues, getIssue: h.getIssue }) },
}));
vi.mock('@bike4mind/server-utils/integrations/github/sreWebhookDispatch', () => ({
  matchesLabelFilter: () => true,
  computeIssueFingerprint: () => 'fp',
  dispatchIssueToSre: h.dispatch,
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import scanHandler from '../scan';
import { resolveFullConfig } from '@bike4mind/common';
import triggerHandler from '../trigger';

const post = async (handler: unknown, body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.listIssues.mockResolvedValue([
    { number: 7, title: 'Boom', html_url: 'https://example.test/7', body: null, labels: [{ name: 'sre' }] },
  ]);
  h.getIssue.mockResolvedValue({
    number: 7,
    title: 'Boom',
    html_url: 'https://example.test/7',
    body: null,
    labels: [{ name: 'sre' }],
  });
  h.dispatch.mockResolvedValue({ dispatched: true });
});

describe('SRE scan and trigger admin audit', () => {
  it('scan records ops.sre.scan_triggered after dispatching', async () => {
    const { req, res } = await post(scanHandler, { repoSlug: 'acme/app' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.scan_triggered',
      target: { kind: 'system', id: 'sre-scan' },
      details: { repoSlug: 'acme/app', scanned: 1, dispatched: 1 },
    });
    expect(h.dispatch.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('trigger records ops.sre.run_triggered after dispatching', async () => {
    const { req, res } = await post(triggerHandler, { issueNumbers: [7] });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.run_triggered',
      target: { kind: 'system', id: 'sre-trigger' },
      summary: 'triggered SRE, dispatched 1 of 1 issues in acme/app',
      details: { repoSlug: 'acme/app', issueNumbers: [7], dispatched: 1 },
    });
    expect(h.dispatch.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('trigger records a config-blocked run with its blockedReason', async () => {
    vi.mocked(resolveFullConfig).mockReturnValueOnce({
      enabled: false,
      sources: { github: { enabled: true } },
    } as never);

    const { res } = await post(triggerHandler, { issueNumbers: [7, 8] });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().results).toEqual([
      { issueNumber: 7, dispatched: false, reason: 'repo-disabled' },
      { issueNumber: 8, dispatched: false, reason: 'repo-disabled' },
    ]);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.run_triggered',
      details: { repoSlug: 'acme/app', issueNumbers: [7, 8], dispatched: 0, blockedReason: 'repo-disabled' },
    });
  });
});
