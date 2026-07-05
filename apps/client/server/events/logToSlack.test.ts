import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { CloudWatchLogsEvent, Context } from 'aws-lambda';

// --- mocks -------------------------------------------------------------------
const mockSendToQueue = vi.fn();
const mockGetSettingsValue = vi.fn();
const mockGetConfiguredRepoSlugs = vi.fn();
const mockResolveFullConfig = vi.fn();
const mockClassifyError = vi.fn();
const mockNotifyEventLogsToSlack = vi.fn();

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

// sst Resource - the standalone logHandler Lambda dispatches via Resource.sreJobQueue.url
vi.mock('sst', () => ({
  Resource: {
    sreJobQueue: { url: 'https://sqs.us-east-2.amazonaws.com/123/sreJobQueue' },
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    STAGE: 'dev',
    MONGODB_URI: 'mongodb://localhost:27017/%STAGE%',
    SLACK_ERROR_REPORTING_WEBHOOK_URL: 'https://hooks.slack.test/x',
  },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
}));

vi.mock('@bike4mind/utils', () => ({
  notifyEventLogsToSlack: (...args: unknown[]) => mockNotifyEventLogsToSlack(...args),
}));

vi.mock('@server/services/liveopsFingerprint', () => ({
  extractErrorType: vi.fn(() => 'TypeError'),
  normalizeErrorMessage: vi.fn((m: string) => m),
}));

vi.mock('./logToSlackClassify', () => ({
  classifyError: (...args: unknown[]) => mockClassifyError(...args),
}));

vi.mock('@bike4mind/common', () => ({
  SreClassification: { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', SKIP: 'SKIP' },
  SreSourceType: { CLOUDWATCH: 'CLOUDWATCH', GITHUB_ISSUE: 'GITHUB_ISSUE' },
  getConfiguredRepoSlugs: (...args: unknown[]) => mockGetConfiguredRepoSlugs(...args),
  resolveFullConfig: (...args: unknown[]) => mockResolveFullConfig(...args),
}));

vi.mock('@bike4mind/observability', () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    Logger: vi.fn(function () {
      return logger;
    }),
  };
});

import { ingest } from './logToSlack';

/** Build a CloudWatch Logs event the way AWS delivers it: base64(gzip(JSON)). */
function makeCwEvent(message: string, logGroup = '/aws/lambda/dev-fn'): CloudWatchLogsEvent {
  const logData = { logGroup, logEvents: [{ id: '1', timestamp: 1, message }] };
  const data = gzipSync(Buffer.from(JSON.stringify(logData))).toString('base64');
  return { awslogs: { data } };
}

const ctx = {} as Context;
// CloudWatch log line: timestamp\trequestId\tlevel\tjsonPayload
const errorLine = `2026-01-01\treq-1\tERROR\t${JSON.stringify({ message: 'TypeError: boom', functionName: 'dev-fn' })}`;

describe('logToSlack.ingest — SRE dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsValue.mockResolvedValue({ repos: [{ slug: 'MillionOnMars/lumina5' }] });
    mockGetConfiguredRepoSlugs.mockReturnValue(['MillionOnMars/lumina5']);
    mockResolveFullConfig.mockReturnValue({
      enabled: true,
      dryRun: false,
      sources: { cloudwatch: { enabled: true } },
    });
    mockClassifyError.mockReturnValue('MEDIUM');
  });

  it('dispatches a classified CloudWatch error to sreJobQueue tagged jobType: analysis', async () => {
    await ingest(makeCwEvent(errorLine), ctx);

    expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    const [url, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://sqs.us-east-2.amazonaws.com/123/sreJobQueue');
    expect(payload.jobType).toBe('analysis');
    expect(payload.source).toBe('CLOUDWATCH');
    expect(payload.classification).toBe('MEDIUM');
    expect(payload.repoSlug).toBe('MillionOnMars/lumina5');
  });

  it('sets dryRun on the dispatched payload when the repo is in dry-run mode', async () => {
    mockResolveFullConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      sources: { cloudwatch: { enabled: true } },
    });

    await ingest(makeCwEvent(errorLine), ctx);

    const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.jobType).toBe('analysis');
    expect(payload.dryRun).toBe(true);
  });

  it('does not dispatch when the error classifies as SKIP', async () => {
    mockClassifyError.mockReturnValue('SKIP');

    await ingest(makeCwEvent(errorLine), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it('does not dispatch when no repo has CloudWatch intake enabled', async () => {
    mockResolveFullConfig.mockReturnValue({
      enabled: true,
      dryRun: false,
      sources: { cloudwatch: { enabled: false } },
    });

    await ingest(makeCwEvent(errorLine), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it('still posts the Slack error notification regardless of SRE config', async () => {
    mockGetSettingsValue.mockResolvedValue(undefined); // SRE disabled

    await ingest(makeCwEvent(errorLine), ctx);

    expect(mockNotifyEventLogsToSlack).toHaveBeenCalledTimes(1);
    expect(mockSendToQueue).not.toHaveBeenCalled();
  });
});
