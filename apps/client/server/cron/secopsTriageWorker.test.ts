import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockForSystem = vi.fn();
const mockEmitMetric = vi.fn();
const mockServiceRun = vi.fn();
const mockFindOne = vi.fn();

vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: (...args: unknown[]) => mockForSystem(...args),
  },
}));

vi.mock('@server/services/secopsTriageService', () => ({
  createSecopsTriageService: () => ({
    run: (...args: unknown[]) => mockServiceRun(...args),
  }),
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: vi.fn(() => null),
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
  slackDevWorkspaceRepository: {
    findByIdWithToken: vi.fn(),
    findAllActive: vi.fn().mockResolvedValue([]),
    findBySlackTeamIdWithToken: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', () => ({
  SECOPS_TRIAGE_SCAN_SOURCES: ['web-owasp', 'secrets', 'packages', 'code-semgrep', 'cloud', 'active-defense'] as const,
  SecopsTriageConfigSchema: {
    safeParse: (v: unknown) => ({ success: true, data: { enabled: true, ...(v as Record<string, unknown>) } }),
    parse: (v: unknown) => ({ enabled: true, ...(v as Record<string, unknown>) }),
  },
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
    Logger: vi.fn(() => mockLogger),
  };
});

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

// Passthrough so we can invoke the inner handler directly with (event, context, logger)
vi.mock('../queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { handler } from './secopsTriageWorker';

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] } as never;
}

const mockContext = {} as never;
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const validPayload = {
  stage: 'dev',
  scanSource: 'active-defense',
  findings: [
    {
      id: 'finding-1',
      title: 'probe target not present',
      severity: 'low',
      instances: [],
    },
  ],
};

describe('secopsTriageWorker handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue({ settingValue: { enabled: true } });
    mockEmitMetric.mockResolvedValue(undefined);
  });

  it('does not dead-letter when there is no system GitHub connection', async () => {
    // forSystem returns null in dev (no b4m-prod GitHub App) - a permanent condition
    mockForSystem.mockResolvedValue(null);

    // Must resolve (return), not throw - throwing would route the message to the DLQ
    await expect(handler(makeSqsEvent(validPayload), mockContext, mockLogger)).resolves.toBeUndefined();

    expect(mockServiceRun).not.toHaveBeenCalled();
  });

  it('still emits the NoGitHubConnection failure metric so the condition stays observable', async () => {
    mockForSystem.mockResolvedValue(null);

    await handler(makeSqsEvent(validPayload), mockContext, mockLogger);

    expect(mockEmitMetric).toHaveBeenCalledWith(
      'Lumina5/SecOpsTriage',
      'TriageRunFailure',
      1,
      { Stage: 'dev', ErrorType: 'NoGitHubConnection' },
      expect.anything()
    );
  });
});
