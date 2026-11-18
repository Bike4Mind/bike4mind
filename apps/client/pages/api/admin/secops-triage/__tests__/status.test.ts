// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findSetting: vi.fn(),
  findRecentRuns: vi.fn(),
  findLatestRuns: vi.fn(),
  forSystem: vi.fn(),
  baseOptions: [] as unknown[],
}));

// Runs the adminApi permission guard for real; a thrown HTTP error becomes its status code.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseOptions.push(options);
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const guards: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
        try {
          for (const guard of guards) guard(req, res, () => undefined);
          return await routes[req.method ?? 'GET']?.(req, res);
        } catch (error) {
          res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message });
        }
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (guards.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: h.findSetting },
  secopsTriageRunRepository: {
    findRecentByStage: h.findRecentRuns,
    findLatestPerSourceByStage: h.findLatestRuns,
  },
}));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({ GitHubService: { forSystem: h.forSystem } }));
vi.mock('@bike4mind/server-utils/security/resolveStage', () => ({ resolveStage: () => 'test-stage' }));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }),
}));

import statusRoute from '../status';

const call = async (user: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user });
  await (statusRoute as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const admin = { id: 'admin-1', isAdmin: true };
const member = { id: 'user-1', isAdmin: false };

const repository = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'test-repo',
  full_name: 'test-org/test-repo',
  private: true,
  html_url: 'https://github.com/test-org/test-repo',
  description: null,
  archived: false,
  has_issues: true,
  ...overrides,
});

const github = (allowed = true, getRepository: () => Promise<unknown> = async () => repository()) => ({
  isRepositoryAllowed: vi.fn(() => allowed),
  getRepository: vi.fn(getRepository),
});

const saveConfig = (settingValue: Record<string, unknown> | null) =>
  h.findSetting.mockResolvedValue(settingValue ? { settingValue } : null);

beforeEach(() => {
  vi.clearAllMocks();
  saveConfig({ enabled: true, githubRepo: 'test-org/test-repo' });
  h.findRecentRuns.mockResolvedValue([]);
  h.findLatestRuns.mockResolvedValue([]);
  h.forSystem.mockResolvedValue(github());
});

describe('GET /api/admin/secops-triage/status', () => {
  it('is a JWT-only admin read gated on support:read', () => {
    expect(h.baseOptions).toEqual([expect.objectContaining({ auth: 'jwtOnly', allowedMethods: ['GET'] })]);
  });

  it('rejects a non-admin before reading anything', async () => {
    const res = await call(member);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toContain('support:read');
    expect(h.findSetting).not.toHaveBeenCalled();
    expect(h.forSystem).not.toHaveBeenCalled();
  });

  it('reports a connected, ready repository for the saved config, uncached', async () => {
    const res = await call(admin);

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({
      stage: 'test-stage',
      enabled: true,
      dryRun: false,
      severityThreshold: 'high',
      maxIssuesPerScan: 20,
      github: { connected: true, repo: 'test-org/test-repo', check: { ok: true } },
      recentRuns: [],
      latestRunPerSource: [],
    });
    expect(h.findSetting).toHaveBeenCalledWith({ settingName: 'secopsTriageConfig' });
  });

  it('reports no connection without checking the repository', async () => {
    h.forSystem.mockResolvedValue(null);

    const res = await call(admin);

    expect(res._getJSONData().github).toEqual({ connected: false, repo: 'test-org/test-repo', check: null });
  });

  it.each([
    ['not_configured', { enabled: false, githubRepo: '' }, github()],
    ['not_allowed', { enabled: true, githubRepo: 'test-org/test-repo' }, github(false)],
    ['not_found', { enabled: true, githubRepo: 'test-org/test-repo' }, github(true, async () => null)],
    [
      'archived',
      { enabled: true, githubRepo: 'test-org/test-repo' },
      github(true, async () => repository({ archived: true })),
    ],
    [
      'issues_disabled',
      { enabled: true, githubRepo: 'test-org/test-repo' },
      github(true, async () => repository({ has_issues: false })),
    ],
  ])('surfaces a %s repository', async (reason, config, service) => {
    saveConfig(config);
    h.forSystem.mockResolvedValue(service);

    const res = await call(admin);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().github).toMatchObject({ connected: true, check: { ok: false, reason } });
  });

  it('reports a failed repository lookup as checkError instead of failing', async () => {
    h.forSystem.mockResolvedValue(
      github(true, async () => {
        throw new Error('GitHub unavailable');
      })
    );

    const res = await call(admin);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().github).toEqual({
      connected: true,
      repo: 'test-org/test-repo',
      check: null,
      checkError: true,
    });
  });

  it('reports a connection that cannot be loaded as checkError instead of failing', async () => {
    h.forSystem.mockRejectedValue(new Error('database unavailable'));

    const res = await call(admin);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().github).toEqual({
      connected: false,
      repo: 'test-org/test-repo',
      check: null,
      checkError: true,
    });
  });

  it('shows the saved fields of a config the worker would skip as invalid', async () => {
    saveConfig({ enabled: true, githubRepo: 'not a repo' });

    const res = await call(admin);

    expect(res._getJSONData()).toMatchObject({
      enabled: true,
      github: { repo: 'not a repo', check: { ok: false, reason: 'not_configured' } },
    });
  });

  it('treats a missing setting as the disabled default', async () => {
    saveConfig(null);

    const res = await call(admin);

    expect(res._getJSONData()).toMatchObject({
      enabled: false,
      github: { repo: '', check: { ok: false, reason: 'not_configured' } },
    });
  });

  it('reports the saved dry run, severity threshold and per-scan cap', async () => {
    saveConfig({
      enabled: true,
      githubRepo: 'test-org/test-repo',
      dryRun: true,
      severityThreshold: 'critical',
      maxIssuesPerScan: 5,
    });

    const res = await call(admin);

    expect(res._getJSONData()).toMatchObject({ dryRun: true, severityThreshold: 'critical', maxIssuesPerScan: 5 });
  });

  it('keeps the saved filing fields of a config that breaks a cross-field rule', async () => {
    saveConfig({ enabled: true, githubRepo: '', dryRun: true, maxIssuesPerScan: 7 });

    const res = await call(admin);

    expect(res._getJSONData()).toMatchObject({ enabled: true, dryRun: true, maxIssuesPerScan: 7 });
  });

  it('reports the defaults for a saved value whose fields do not parse', async () => {
    saveConfig({ enabled: true, githubRepo: 'test-org/test-repo', dryRun: true, maxIssuesPerScan: 0 });

    const res = await call(admin);

    expect(res._getJSONData()).toMatchObject({ dryRun: false, severityThreshold: 'high', maxIssuesPerScan: 20 });
  });

  it('returns the newest run of each scan source on the stage, without ids', async () => {
    h.findLatestRuns.mockResolvedValue([
      {
        id: 'run-9',
        stage: 'test-stage',
        scanSource: 'active-defense',
        status: 'failed',
        dryRun: false,
        findingCount: 3,
        error: 'rate limited',
        startedAt: new Date('2026-11-17T11:00:00Z'),
      },
      {
        id: 'run-4',
        stage: 'test-stage',
        scanSource: 'cloud',
        status: 'skipped',
        reason: 'not_allowed',
        dryRun: false,
        findingCount: 0,
        startedAt: new Date('2026-11-17T09:00:00Z'),
      },
    ]);

    const res = await call(admin);

    expect(h.findLatestRuns).toHaveBeenCalledWith('test-stage');
    expect(res._getJSONData().latestRunPerSource).toEqual([
      {
        scanSource: 'active-defense',
        status: 'failed',
        dryRun: false,
        findingCount: 3,
        error: 'rate limited',
        startedAt: '2026-11-17T11:00:00.000Z',
      },
      {
        scanSource: 'cloud',
        status: 'skipped',
        reason: 'not_allowed',
        dryRun: false,
        findingCount: 0,
        startedAt: '2026-11-17T09:00:00.000Z',
      },
    ]);
  });

  it('returns the stage recent runs newest first, without ids', async () => {
    h.findRecentRuns.mockResolvedValue([
      {
        id: 'run-2',
        stage: 'test-stage',
        scanSource: 'web-owasp',
        status: 'completed',
        dryRun: false,
        findingCount: 2,
        counts: { created: 1, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 1, overCap: 0 },
        startedAt: new Date('2026-11-17T10:05:00Z'),
        durationMs: 900,
      },
      {
        id: 'run-1',
        stage: 'test-stage',
        scanSource: 'secrets',
        status: 'skipped',
        reason: 'disabled',
        dryRun: false,
        findingCount: 0,
        startedAt: new Date('2026-11-17T10:00:00Z'),
      },
    ]);

    const res = await call(admin);

    expect(h.findRecentRuns).toHaveBeenCalledWith('test-stage', 10);
    expect(res._getJSONData().recentRuns).toEqual([
      {
        scanSource: 'web-owasp',
        status: 'completed',
        dryRun: false,
        findingCount: 2,
        counts: { created: 1, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 1, overCap: 0 },
        startedAt: '2026-11-17T10:05:00.000Z',
        durationMs: 900,
      },
      {
        scanSource: 'secrets',
        status: 'skipped',
        reason: 'disabled',
        dryRun: false,
        findingCount: 0,
        startedAt: '2026-11-17T10:00:00.000Z',
      },
    ]);
  });
});
