import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailJobStatus, EmailSendStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

// Passthrough so `dispatch` is the raw (event, ctx, logger) handler - the queue is
// subscribed with batch.partialResponses: true, so dispatch's return value (the
// batchItemFailures contract) is what SQS actually reads.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const mockFindJobById = vi.fn();
const mockFindTemplateById = vi.fn();
const mockFindAttemptById = vi.fn();
const mockIncrementCountsBy = vi.fn();
const mockUpdateJob = vi.fn();
const mockCountAttempts = vi.fn();
const sendMocks = vi.hoisted(() => ({
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  updateAttemptStatus: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  emailJobRepository: {
    findById: (...args: unknown[]) => mockFindJobById(...args),
    incrementCountsBy: (...args: unknown[]) => mockIncrementCountsBy(...args),
    update: (...args: unknown[]) => mockUpdateJob(...args),
  },
  emailSendAttemptRepository: {
    findById: (...args: unknown[]) => mockFindAttemptById(...args),
    count: (...args: unknown[]) => mockCountAttempts(...args),
    updateStatus: sendMocks.updateAttemptStatus,
  },
  emailTemplateRepository: {
    findById: (...args: unknown[]) => mockFindTemplateById(...args),
  },
  userRepository: { findById: sendMocks.findUserById },
  subscriberRepository: { findById: vi.fn() },
}));

// The real queuedMailer runs: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: sendMocks.publish } },
}));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({
  default: { sendEmail: sendMocks.smtpSendEmail },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

import { dispatch, renderTemplate } from './emailBatch';

function makeSqsEvent(messages: Array<{ messageId: string; body: Record<string, unknown> }>) {
  return {
    Records: messages.map(m => ({ messageId: m.messageId, body: JSON.stringify(m.body) })),
  } as never;
}

const basePayload = (jobId: string, attemptIds: string[]) => ({
  jobId,
  attemptIds,
  templateId: 'template-1',
  batchIndex: 0,
  totalBatches: 1,
});

describe('emailBatch dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountAttempts.mockResolvedValue(0);
  });

  it('reports only the failing record in batchItemFailures, still processing the rest', async () => {
    mockFindJobById.mockImplementation(async (jobId: string) => {
      if (jobId === 'job-bad') {
        throw new Error('db unavailable');
      }
      return { id: jobId, status: EmailJobStatus.PROCESSING, variables: {} };
    });
    mockFindTemplateById.mockResolvedValue({ id: 'template-1', subject: 'hi', htmlContent: '<p>hi</p>' });
    // No pending attempts -> the good record short-circuits before touching the mailer.
    mockFindAttemptById.mockResolvedValue(null);

    const event = makeSqsEvent([
      { messageId: 'msg-good', body: basePayload('job-good', ['attempt-1']) },
      { messageId: 'msg-bad', body: basePayload('job-bad', ['attempt-2']) },
    ]);

    const result = await dispatch(event, {} as never, mockLogger);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-bad' }] });
  });

  it('returns an empty batchItemFailures when every record succeeds', async () => {
    mockFindJobById.mockResolvedValue({ id: 'job-good', status: EmailJobStatus.PROCESSING, variables: {} });
    mockFindTemplateById.mockResolvedValue({ id: 'template-1', subject: 'hi', htmlContent: '<p>hi</p>' });
    mockFindAttemptById.mockResolvedValue(null);

    const event = makeSqsEvent([
      { messageId: 'msg-1', body: basePayload('job-good', ['attempt-1']) },
      { messageId: 'msg-2', body: basePayload('job-good', ['attempt-2']) },
    ]);

    const result = await dispatch(event, {} as never, mockLogger);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockUpdateJob).not.toHaveBeenCalled();
  });
});

describe('emailBatch delivery through the event bus', () => {
  const pendingAttempt = (overrides: Record<string, unknown> = {}) => ({
    id: 'attempt-1',
    status: EmailSendStatus.PENDING,
    recipientEmail: 'to@example.org',
    recipientId: 'user-1',
    recipientType: 'user',
    trackingToken: 'tok-1',
    retryCount: 0,
    ...overrides,
  });

  const run = async () => {
    const result = dispatch(
      makeSqsEvent([{ messageId: 'msg-1', body: basePayload('job-1', ['attempt-1']) }]),
      {} as never,
      mockLogger
    );
    await vi.runAllTimersAsync();
    return result;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('B4M_SELF_HOST', 'false');
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    mockCountAttempts.mockResolvedValue(0);
    mockFindJobById.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.PROCESSING, variables: {} });
    mockFindTemplateById.mockResolvedValue({
      id: 'template-1',
      subject: 'Hi {{userName}}',
      htmlContent: '<p>Hello {{userName}}</p>',
    });
    mockFindAttemptById.mockResolvedValue(pendingAttempt());
    sendMocks.findUserById.mockResolvedValue({ name: 'Ada Lovelace' });
    sendMocks.updateAttemptStatus.mockResolvedValue(undefined);
    sendMocks.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('publishes the rendered mail as an email.send event and marks the attempt sent', async () => {
    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'to@example.org',
        subject: 'Hi Ada Lovelace',
        body: expect.stringContaining('Hello Ada Lovelace'),
      })
    );
    expect(sendMocks.publish.mock.calls[0][0].body).toContain('/api/email/track/open/tok-1');
    expect(sendMocks.smtpSendEmail).not.toHaveBeenCalled();
    expect(sendMocks.updateAttemptStatus).toHaveBeenNthCalledWith(1, 'attempt-1', EmailSendStatus.PROCESSING);
    expect(sendMocks.updateAttemptStatus).toHaveBeenNthCalledWith(
      2,
      'attempt-1',
      EmailSendStatus.SENT,
      expect.objectContaining({ renderedSubject: 'Hi Ada Lovelace', retryCount: 0 })
    );
    expect(mockIncrementCountsBy).toHaveBeenCalledWith('job-1', 'sentCount', 1);
    expect(mockIncrementCountsBy).not.toHaveBeenCalledWith('job-1', 'failedCount', expect.anything());
  });

  it('prefixes the subject on a test send', async () => {
    mockFindAttemptById.mockResolvedValue(pendingAttempt({ testSubjectIndicator: true }));

    await run();

    expect(sendMocks.publish).toHaveBeenCalledWith(expect.objectContaining({ subject: '[TEST] Hi Ada Lovelace' }));
  });

  it('retries a publish that fails and marks the attempt sent once one goes through', async () => {
    sendMocks.publish.mockRejectedValueOnce(new Error('bus unreachable'));

    await run();

    expect(sendMocks.publish).toHaveBeenCalledTimes(2);
    expect(sendMocks.updateAttemptStatus).toHaveBeenLastCalledWith(
      'attempt-1',
      EmailSendStatus.SENT,
      expect.objectContaining({ retryCount: 1 })
    );
  });

  it('marks the attempt failed when every publish is rejected', async () => {
    sendMocks.publish.mockRejectedValue(new Error('bus unreachable'));

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledTimes(3);
    expect(sendMocks.updateAttemptStatus).toHaveBeenLastCalledWith(
      'attempt-1',
      EmailSendStatus.FAILED,
      expect.objectContaining({
        errorMessage: expect.stringContaining('Failed after 3 attempts'),
        retryCount: 3,
      })
    );
    expect(sendMocks.updateAttemptStatus).not.toHaveBeenCalledWith(
      'attempt-1',
      EmailSendStatus.SENT,
      expect.anything()
    );
    expect(sendMocks.smtpSendEmail).not.toHaveBeenCalled();
    expect(mockIncrementCountsBy).toHaveBeenCalledWith('job-1', 'failedCount', 1);
    expect(mockIncrementCountsBy).not.toHaveBeenCalledWith('job-1', 'sentCount', expect.anything());
  });

  it('marks the attempt failed when the bus rejects the entry without throwing', async () => {
    sendMocks.publish.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }],
    });

    await run();

    expect(sendMocks.publish).toHaveBeenCalledTimes(3);
    expect(sendMocks.updateAttemptStatus).toHaveBeenLastCalledWith(
      'attempt-1',
      EmailSendStatus.FAILED,
      expect.objectContaining({ errorMessage: expect.stringContaining('Failed after 3 attempts') })
    );
  });
});

describe('renderTemplate variable substitution', () => {
  const template = (subject: string, htmlContent: string) => ({ subject, htmlContent }) as never;

  beforeEach(() => {
    process.env.APP_URL = 'https://app.example.com';
  });

  it('HTML-escapes substituted values', () => {
    const { html } = renderTemplate(
      template('hi', '<p>Hello {{userName}}</p>'),
      { userName: '<img src=x onerror=alert(1)>' },
      'tok'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('does not expand $-patterns in the value into raw template text', () => {
    // With a plain string replacement, `$&` in the replacement expands to the matched
    // substring, so the `{{userName}}` placeholder would be spliced back in verbatim.
    // A function replacer inserts the (escaped) value literally instead.
    const { html } = renderTemplate(template('hi', 'A{{userName}}B'), { userName: '$&' }, 'tok');
    expect(html).not.toContain('{{userName}}');
    expect(html).toContain('A$&amp;B');
  });

  it('puts the unsubscribe token in the URL fragment, not the query string', () => {
    const { html } = renderTemplate(template('hi', '<a href="{{unsubscribeUrl}}">Unsubscribe</a>'), {}, 'tok-123');
    expect(html).toContain('href="https://app.example.com/email/unsubscribe#token=tok-123"');
    expect(html).not.toContain('unsubscribe?token=');
  });
});
