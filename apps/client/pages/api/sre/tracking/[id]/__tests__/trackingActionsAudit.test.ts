// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findFullById: vi.fn(),
  dismiss: vi.fn(),
  sendToQueue: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
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
  resolveFullConfig: () => ({
    enabled: true,
    circuitBreaker: { cooldownMinutes: 10, failureThreshold: 5 },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  sreErrorTrackingRepository: {
    findFullById: h.findFullById,
    dismiss: h.dismiss,
    countConsecutiveFailures: vi.fn().mockResolvedValue(0),
    deleteTerminalByFingerprint: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  },
  cacheRepository: { deleteByKey: vi.fn().mockResolvedValue(undefined) },
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue({}) },
  DISMISSABLE_STATUSES: ['failed'],
  RETRYABLE_STATUSES: ['failed'],
}));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({ GitHubService: { forSystem: vi.fn() } }));
vi.mock('@bike4mind/server-utils/integrations/github/sreWebhookDispatch', () => ({
  dispatchIssueToSre: vi.fn(),
  parseIssueNumberFromUrl: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'sre-queue-url' }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import { GitHubService } from '@bike4mind/server-utils/services/githubService';
import { dispatchIssueToSre } from '@bike4mind/server-utils/integrations/github/sreWebhookDispatch';
import dismissHandler from '../dismiss';
import rerunHandler from '../rerun';
import retryHandler from '../retry';

const TRACKING_ID = '507f1f77bcf86cd799439011';

const post = async (handler: unknown, body?: unknown) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: TRACKING_ID }, body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as Route)(req, res);
  return { req, res };
};

const trackingDoc = (status: string) => ({
  id: TRACKING_ID,
  status,
  errorFingerprint: 'fp-1',
  source: 'CLOUDWATCH',
  repoSlug: 'acme/app',
  sourceRef: 'log-group',
  errorMessage: 'boom',
});

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.sendToQueue.mockResolvedValue(undefined);
  h.dismiss.mockResolvedValue({ id: TRACKING_ID });
});

describe('SRE tracking actions admin audit', () => {
  it('dismiss records ops.sre.tracking_dismissed with the reason', async () => {
    h.findFullById.mockResolvedValue(trackingDoc('failed'));

    const { req, res } = await post(dismissHandler, { reason: 'known noise' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.tracking_dismissed',
      target: { kind: 'system', id: TRACKING_ID },
      reason: 'known noise',
    });
    expect(h.dismiss.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('rerun records ops.sre.tracking_rerun after dispatching', async () => {
    h.findFullById.mockResolvedValue(trackingDoc('dismissed'));

    const { res } = await post(rerunHandler);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.tracking_rerun',
      target: { kind: 'system', id: TRACKING_ID },
    });
    expect(h.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('rerun records a blocked GitHub dispatch with its reason', async () => {
    h.findFullById.mockResolvedValue({ ...trackingDoc('dismissed'), source: 'GITHUB_ISSUE', githubIssueNumber: 7 });
    vi.mocked(GitHubService.forSystem).mockResolvedValue({
      getIssue: vi
        .fn()
        .mockResolvedValue({ number: 7, state: 'open', title: 't', html_url: 'u', body: null, labels: [] }),
    } as unknown as Awaited<ReturnType<typeof GitHubService.forSystem>>);
    vi.mocked(dispatchIssueToSre).mockResolvedValue({ dispatched: false, reason: 'label-mismatch' } as Awaited<
      ReturnType<typeof dispatchIssueToSre>
    >);

    const { res } = await post(rerunHandler);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.tracking_rerun',
      summary: 'rerun of SRE tracking fp-1 blocked (label-mismatch)',
      details: { source: 'GITHUB_ISSUE', dispatched: false, reason: 'label-mismatch' },
    });
  });

  it('retry records ops.sre.tracking_retried after re-queueing', async () => {
    h.findFullById.mockResolvedValue(trackingDoc('failed'));

    const { res } = await post(retryHandler);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.tracking_retried',
      target: { kind: 'system', id: TRACKING_ID },
      details: { previousStatus: 'failed', dispatched: true },
    });
    expect(h.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('retry records a blocked GitHub dispatch with its reason', async () => {
    h.findFullById.mockResolvedValue({ ...trackingDoc('failed'), source: 'GITHUB_ISSUE', githubIssueNumber: 7 });
    vi.mocked(GitHubService.forSystem).mockResolvedValue({
      getIssue: vi
        .fn()
        .mockResolvedValue({ number: 7, state: 'open', title: 't', html_url: 'u', body: null, labels: [] }),
    } as unknown as Awaited<ReturnType<typeof GitHubService.forSystem>>);
    vi.mocked(dispatchIssueToSre).mockResolvedValueOnce({ dispatched: false, reason: 'label-mismatch' } as Awaited<
      ReturnType<typeof dispatchIssueToSre>
    >);

    const { res } = await post(retryHandler);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.tracking_retried',
      summary: 'retry of SRE tracking fp-1 blocked (label-mismatch)',
      details: { source: 'GITHUB_ISSUE', dispatched: false, reason: 'label-mismatch' },
    });
  });
});
