import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindStaleDispatches = vi.fn();
const mockFindStaleByStatus = vi.fn();
const mockAtomicTransition = vi.fn();
const mockGetSettingsValue = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  sreErrorTrackingRepository: {
    findStaleDispatches: (...args: unknown[]) => mockFindStaleDispatches(...args),
    findStaleByStatus: (...args: unknown[]) => mockFindStaleByStatus(...args),
    atomicTransition: (...args: unknown[]) => mockAtomicTransition(...args),
  },
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
}));

vi.mock('@bike4mind/common', () => ({
  SreAgentConfigSchema: {
    parse: vi.fn((v: unknown) => ({
      repos: [],
      ...(v as Record<string, unknown>),
    })),
  },
  SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
  getConfiguredRepoSlugs: vi.fn(() => ['MillionOnMars/lumina5']),
  resolveFullConfig: vi.fn((_config: unknown, _repoSlug: unknown) => ({
    gates: {
      diagnosticianToSurgeon: {
        approvalTimeoutHours: 12,
      },
    },
    slack: {},
  })),
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    updateMetadata: vi.fn(),
  };
  mockLogger.withMetadata = vi.fn(() => mockLogger);
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@server/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://localhost:27017/%STAGE%',
    STAGE: 'dev',
  },
}));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreTimeoutSummaryMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handler } from './sreStaleDispatch';

describe('sreStaleDispatch cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindStaleDispatches.mockResolvedValue([]);
    mockFindStaleByStatus.mockResolvedValue([]);
    mockGetSettingsValue.mockResolvedValue({});
    mockAtomicTransition.mockResolvedValue({ id: 'doc-1' });
  });

  it('should blame GitHub Actions when the dispatch reached GitHub', async () => {
    mockFindStaleDispatches.mockResolvedValue([{ id: 'doc-1', errorFingerprint: 'fp-1', githubRunDispatched: true }]);

    const result = await handler();

    expect(mockFindStaleDispatches).toHaveBeenCalledWith(20);
    expect(mockAtomicTransition).toHaveBeenCalledWith('doc-1', 'fixing', 'failed', {
      errorMessage: expect.stringContaining('timed out after 20 minutes'),
    });
    const { errorMessage } = mockAtomicTransition.mock.calls[0][3];
    expect(errorMessage).toContain('dispatched to GitHub Actions but no callback received');
    expect(errorMessage).not.toContain('sreFix handler never dispatched');
    expect(result.transitioned).toBe(1);
  });

  // Regression guard: a sreFix Lambda that dies before claimDispatch leaves
  // githubRunDispatched absent, and the old message blamed GitHub Actions for a
  // dispatch that never happened.
  it('should blame the sreFix handler when githubRunDispatched is absent', async () => {
    mockFindStaleDispatches.mockResolvedValue([{ id: 'doc-1', errorFingerprint: 'fp-1' }]);

    const result = await handler();

    const { errorMessage } = mockAtomicTransition.mock.calls[0][3];
    expect(errorMessage).toContain('timed out after 20 minutes');
    expect(errorMessage).toContain('sreFix handler never dispatched to GitHub');
    expect(errorMessage).not.toContain('no callback received');
    expect(result.transitioned).toBe(1);
  });

  // A revision cycle resets githubRunDispatched to false, so explicit false must
  // read the same as absent rather than falling through to the dispatched branch.
  it('should treat githubRunDispatched: false as never dispatched', async () => {
    mockFindStaleDispatches.mockResolvedValue([{ id: 'doc-1', errorFingerprint: 'fp-1', githubRunDispatched: false }]);

    await handler();

    expect(mockAtomicTransition.mock.calls[0][3].errorMessage).toContain('sreFix handler never dispatched to GitHub');
  });

  it('should timeout stale analyzing docs after 10 min', async () => {
    mockFindStaleByStatus.mockImplementation((status: string) => {
      if (status === 'analyzing') return Promise.resolve([{ id: 'doc-2' }]);
      return Promise.resolve([]);
    });

    const result = await handler();

    expect(mockFindStaleByStatus).toHaveBeenCalledWith('analyzing', 10);
    expect(mockAtomicTransition).toHaveBeenCalledWith('doc-2', 'analyzing', 'failed', {
      errorMessage: expect.stringContaining('Analysis timed out'),
    });
    expect(result.transitioned).toBe(1);
  });

  it('should timeout stale awaiting_approval docs using config timeout', async () => {
    mockFindStaleByStatus.mockImplementation((status: string) => {
      if (status === 'awaiting_approval')
        return Promise.resolve([
          {
            id: 'doc-3',
            updatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13h ago — exceeds 12h timeout
          },
        ]);
      return Promise.resolve([]);
    });

    const result = await handler();

    expect(mockFindStaleByStatus).toHaveBeenCalledWith('awaiting_approval', 720);
    expect(mockAtomicTransition).toHaveBeenCalledWith('doc-3', 'awaiting_approval', 'approval_expired', {
      errorMessage: expect.stringContaining('Approval timed out after 12h'),
    });
    expect(result.transitioned).toBe(1);
  });

  it('should skip already-transitioned docs (atomicTransition returns null)', async () => {
    mockFindStaleByStatus.mockImplementation((status: string) => {
      if (status === 'awaiting_approval') return Promise.resolve([{ id: 'doc-4' }]);
      return Promise.resolve([]);
    });
    mockAtomicTransition.mockResolvedValue(null);

    const result = await handler();

    expect(result.transitioned).toBe(0);
  });

  it('should not short-circuit when no stale fixing docs exist', async () => {
    // No stale fixing docs, but there are stale analyzing docs
    mockFindStaleDispatches.mockResolvedValue([]);
    mockFindStaleByStatus.mockImplementation((status: string) => {
      if (status === 'analyzing') return Promise.resolve([{ id: 'doc-5' }]);
      return Promise.resolve([]);
    });

    const result = await handler();

    expect(mockFindStaleByStatus).toHaveBeenCalledWith('analyzing', 10);
    expect(result.transitioned).toBe(1);
  });
});
