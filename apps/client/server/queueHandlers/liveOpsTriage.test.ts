import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatch } from './liveOpsTriage';

const mockFindOne = vi.fn();
const mockFindById = vi.fn();
const mockMarkStarted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkComplete = vi.fn();
const mockUpdateProgress = vi.fn();
const mockFindByIdWithToken = vi.fn();
const mockFindAllActive = vi.fn();
const mockFindBySlackTeamIdWithToken = vi.fn();

vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
  slackDevWorkspaceRepository: {
    findByIdWithToken: (...args: unknown[]) => mockFindByIdWithToken(...args),
    findAllActive: (...args: unknown[]) => mockFindAllActive(...args),
    findBySlackTeamIdWithToken: (...args: unknown[]) => mockFindBySlackTeamIdWithToken(...args),
  },
  liveOpsTriageJobRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    markStarted: (...args: unknown[]) => mockMarkStarted(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    markComplete: (...args: unknown[]) => mockMarkComplete(...args),
    updateProgress: (...args: unknown[]) => mockUpdateProgress(...args),
  },
}));

vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    LiveopsTriageConfigSchema: {
      parse: vi.fn((v: unknown) => v),
    },
  };
});

const mockForSystem = vi.fn();
vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: (...args: unknown[]) => mockForSystem(...args),
  },
}));

const mockRunDryRun = vi.fn();
const mockRunTriage = vi.fn();
vi.mock('@server/services/liveopsTriageService', () => ({
  createLiveopsTriageService: vi.fn(() => ({
    runDryRun: (...args: unknown[]) => mockRunDryRun(...args),
    runTriage: (...args: unknown[]) => mockRunTriage(...args),
  })),
  sanitizeErrorMessage: vi.fn((msg: string) => msg),
}));

const mockEmitMetric = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: vi.fn(() => 'decrypted-token'),
}));

vi.mock('./utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] };
}

const mockContext = {} as never;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

describe('liveOpsTriage handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'job-1', status: 'pending' });
    mockFindOne.mockResolvedValue({ settingValue: { enabled: true, slackWorkspaceId: 'ws-1' } });
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'encrypted-token' });
    mockRunDryRun.mockResolvedValue({ status: 'success', alertsFetched: 0, issuesWouldCreate: [] });
    mockRunTriage.mockResolvedValue({ status: 'success', errorsProcessed: 0, issuesCreated: [] });
  });

  describe('permanent GitHub misconfiguration (forSystem returns null)', () => {
    it('does NOT re-throw, so SQS will not retry', async () => {
      mockForSystem.mockResolvedValue(null);

      await expect(
        dispatch(
          makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: false }),
          mockContext,
          mockLogger
        )
      ).resolves.toBeUndefined();
    });

    it('marks the job failed with a specific reason', async () => {
      mockForSystem.mockResolvedValue(null);

      await dispatch(
        makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: false }),
        mockContext,
        mockLogger
      );

      expect(mockMarkFailed).toHaveBeenCalledWith('507f1f77bcf86cd799439011', {
        errorMessage: 'No system GitHub connection configured',
      });
    });

    it('emits a failure metric tagged as a permanent NoGitHubConnection error', async () => {
      mockForSystem.mockResolvedValue(null);

      await dispatch(
        makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: true }),
        mockContext,
        mockLogger
      );

      expect(mockEmitMetric).toHaveBeenCalledWith(
        expect.any(String),
        'ManualRunFailure',
        1,
        expect.objectContaining({ ErrorType: 'NoGitHubConnection' }),
        expect.anything()
      );
    });

    it('never reaches runTriage/runDryRun', async () => {
      mockForSystem.mockResolvedValue(null);

      await dispatch(
        makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: false }),
        mockContext,
        mockLogger
      );

      expect(mockRunTriage).not.toHaveBeenCalled();
      expect(mockRunDryRun).not.toHaveBeenCalled();
    });
  });

  describe('transient forSystem failure', () => {
    it('still re-throws so SQS retries', async () => {
      mockForSystem.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        dispatch(
          makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: false }),
          mockContext,
          mockLogger
        )
      ).rejects.toThrow('DB connection lost');

      expect(mockMarkFailed).toHaveBeenCalledWith('507f1f77bcf86cd799439011', { errorMessage: 'DB connection lost' });
    });
  });

  describe('happy path', () => {
    it('completes the job when GitHub and Slack are both available', async () => {
      mockForSystem.mockResolvedValue({ someGithubClient: true });

      await dispatch(
        makeSqsEvent({ jobId: '507f1f77bcf86cd799439011', userId: 'u1', dryRun: true }),
        mockContext,
        mockLogger
      );

      expect(mockMarkComplete).toHaveBeenCalled();
      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });
});
