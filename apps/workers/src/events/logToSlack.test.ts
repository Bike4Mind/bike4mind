import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { CloudWatchLogsEvent, Context } from 'aws-lambda';

// --- mocks -------------------------------------------------------------------
const mockSendToQueue = vi.fn();
const mockGetSettingsValue = vi.fn();
const mockGetConfiguredRepoSlugs = vi.fn();
const mockResolveFullConfig = vi.fn();
const mockNotifyEventLogsToSlack = vi.fn();

vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

// sst Resource - the standalone logHandler Lambda dispatches via Resource.sreJobQueue.url
vi.mock('sst', () => ({
  Resource: {
    sreJobQueue: { url: 'https://sqs.us-east-2.amazonaws.com/123/sreJobQueue' },
  },
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
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

vi.mock('@bike4mind/server-utils/services/liveopsFingerprint', () => ({
  extractErrorType: vi.fn(() => 'TypeError'),
  normalizeErrorMessage: vi.fn((m: string) => m),
}));

vi.mock('@bike4mind/common', () => ({
  SreClassification: { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', SKIP: 'SKIP' },
  SreSourceType: { CLOUDWATCH: 'CLOUDWATCH', GITHUB_ISSUE: 'GITHUB_ISSUE' },
  getConfiguredRepoSlugs: (...args: unknown[]) => mockGetConfiguredRepoSlugs(...args),
  resolveFullConfig: (...args: unknown[]) => mockResolveFullConfig(...args),
}));

vi.mock('@bike4mind/observability', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/observability')>();
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    redactLogText: actual.redactLogText,
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

  it('dispatches a raw-JSON Fargate line with the parsed message (no tab prefix)', async () => {
    // ChatCompletion's container log line is the logger's raw JSON, so the SRE intake
    // must parse the whole message rather than reading a positional tab field.
    const fargateLine = JSON.stringify({
      severity: 'error',
      message: 'Drain window expired with in-flight quests',
      stack: 'Error: Drain window expired\n    at drain (worker.ts:10:2)',
      functionName: 'chatCompletion',
    });

    await ingest(makeCwEvent(fargateLine, '/sst/cluster/dev/ChatCompletion'), ctx);

    expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.errorMessage).toBe('Drain window expired with in-flight quests');
    expect(payload.functionName).toBe('chatCompletion');
    expect(payload.logGroup).toBe('/sst/cluster/dev/ChatCompletion');
  });

  it('scrubs contact details and credentials from a raw console line before dispatching it', async () => {
    const consoleLine = `2026-01-01\treq-1\tERROR\tTypeError: send failed for jane@example.com with Bearer abc.def`;

    await ingest(makeCwEvent(consoleLine), ctx);

    const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(payload)).not.toContain('jane@');
    expect(JSON.stringify(payload)).not.toContain('abc.def');
    expect(payload.stackTrace).toBe('TypeError: send failed for ***@example.com with Bearer [REDACTED]');
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
    await ingest(makeCwEvent('Request aborted'), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it.each([false, true])('ignores a request prefix when structured=%s', async structured => {
    const message = 'GET /TypeError/ZodError \u2192 500: Not available';
    const line = structured ? JSON.stringify({ message, path: '/ReferenceError' }) : message;

    await ingest(makeCwEvent(line), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['ZodError: invalid input', 'HIGH'],
    ['TypeError: invalid value', 'MEDIUM'],
  ])('dispatches %s with only message and stack context', async (message, classification) => {
    const stack = `${message}\n    at handle (handler.ts:10:2)`;
    const line = JSON.stringify({
      message: `POST /request-metadata \u2192 500: ${message}`,
      error: { stack, path: '/nested-metadata', headers: { note: 'nested context' } },
      path: '/request-metadata',
      headers: { note: 'request context' },
    });

    await ingest(makeCwEvent(line), ctx);

    expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ errorMessage: message, classification, stackTrace: `${message}\n${stack}` });
    const fingerprint = payload.fingerprint;
    mockSendToQueue.mockClear();
    await ingest(makeCwEvent(JSON.stringify({ message, error: { stack } })), ctx);
    expect(mockSendToQueue.mock.calls[0][1].fingerprint).toBe(fingerprint);
  });

  it.each([
    { path: '/TypeError', message: 'Not available' },
    { path: '/ZodError' },
    { message: { detail: 'TypeError' }, stack: { detail: 'ZodError' } },
    null,
    ['TypeError'],
    'TypeError',
  ])('does not classify non-error JSON fields: %j', async value => {
    await ingest(makeCwEvent(JSON.stringify(value)), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it.each(['stack', 'stackTrace'])('includes a top-level %s string', async field => {
    const stack = 'ReferenceError: missing\n    at handle (handler.ts:10:2)';
    await ingest(makeCwEvent(JSON.stringify({ errorMessage: 'Handler failed', [field]: stack })), ctx);

    expect(mockSendToQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        errorMessage: 'Handler failed',
        classification: 'MEDIUM',
        stackTrace: `Handler failed\n${stack}`,
      })
    );
  });

  it('includes a serialized err stack without its other fields', async () => {
    const stack = 'TypeError: failed\n    at handle (handler.ts:10:2)';
    await ingest(makeCwEvent(JSON.stringify({ message: 'Failed', err: { stack, path: '/metadata' } })), ctx);

    expect(mockSendToQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stackTrace: `Failed\n${stack}`, classification: 'MEDIUM' })
    );
  });

  it.each([undefined, {}, { repos: [] }])('does not dispatch with unset or empty config: %j', async config => {
    mockGetSettingsValue.mockResolvedValue(config);
    mockGetConfiguredRepoSlugs.mockReturnValue([]);

    await ingest(makeCwEvent(errorLine), ctx);

    expect(mockSendToQueue).not.toHaveBeenCalled();
    expect(mockResolveFullConfig).not.toHaveBeenCalled();
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
