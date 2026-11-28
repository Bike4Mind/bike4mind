import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailJobOverallStatus, EmailJobStatus, EmailSendStatus } from '@bike4mind/common';
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
const mockCompleteRun = vi.fn();
const mockUpdateCounts = vi.fn().mockResolvedValue(true);
const mockCountAttempts = vi.fn();
const sendMocks = vi.hoisted(() => ({
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  claimForSend: vi.fn(),
  markSendAccepted: vi.fn(),
  markQueued: vi.fn(),
  recordOutcome: vi.fn(),
  markSendFailed: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  emailJobRepository: {
    findById: (...args: unknown[]) => mockFindJobById(...args),
    incrementCountsBy: (...args: unknown[]) => mockIncrementCountsBy(...args),
    update: (...args: unknown[]) => mockUpdateJob(...args),
    completeRun: (...args: unknown[]) => mockCompleteRun(...args),
    updateCounts: (...args: unknown[]) => mockUpdateCounts(...args),
  },
  emailSendAttemptRepository: {
    findById: (...args: unknown[]) => mockFindAttemptById(...args),
    count: (...args: unknown[]) => mockCountAttempts(...args),
    claimForSend: sendMocks.claimForSend,
    markSendAccepted: sendMocks.markSendAccepted,
    markQueued: sendMocks.markQueued,
    recordDeliveryOutcome: sendMocks.recordOutcome,
    markSendFailed: sendMocks.markSendFailed,
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
    sendMocks.claimForSend.mockResolvedValue(true);
    sendMocks.markSendAccepted.mockResolvedValue(true);
    sendMocks.markQueued.mockResolvedValue(true);
    sendMocks.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('publishes the rendered mail with its attempt ref and marks the attempt queued', async () => {
    mockCountAttempts.mockImplementation(async (filter: { status?: unknown }) => {
      if (filter.status === undefined) return 1;
      const statuses = (filter.status as { $in?: string[] }).$in ?? [filter.status];
      return statuses.includes(EmailSendStatus.QUEUED) ? 1 : 0;
    });
    mockCompleteRun.mockResolvedValue(true);

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'to@example.org',
        subject: 'Hi Ada Lovelace',
        body: expect.stringContaining('Hello Ada Lovelace'),
        ref: { kind: 'emailAttempt', attemptId: 'attempt-1' },
      })
    );
    expect(sendMocks.publish.mock.calls[0][0].body).toContain('/api/email/track/open/tok-1');
    expect(sendMocks.smtpSendEmail).not.toHaveBeenCalled();
    expect(sendMocks.claimForSend).toHaveBeenCalledExactlyOnceWith(
      'attempt-1',
      expect.objectContaining({ renderedSubject: 'Hi Ada Lovelace' })
    );
    expect(sendMocks.claimForSend.mock.invocationCallOrder[0]).toBeLessThan(
      sendMocks.publish.mock.invocationCallOrder[0]
    );
    expect(sendMocks.markQueued).toHaveBeenCalledWith('attempt-1', expect.objectContaining({ retryCount: 0 }));
    expect(sendMocks.recordOutcome).not.toHaveBeenCalled();
    expect(mockIncrementCountsBy).not.toHaveBeenCalled();
    expect(mockCompleteRun).toHaveBeenCalledWith(
      'job-1',
      undefined,
      undefined,
      expect.objectContaining({ sentCount: 1, failedCount: 0, overallStatus: EmailJobOverallStatus.COMPLETE })
    );
  });

  it('records a self-host send as sent, since that result is the delivery itself', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    sendMocks.smtpSendEmail.mockResolvedValue({ messageId: 'smtp-1' });

    await run();

    expect(sendMocks.publish).not.toHaveBeenCalled();
    expect(sendMocks.recordOutcome).toHaveBeenCalledWith(
      'attempt-1',
      { ok: true, at: expect.any(Date) },
      { retryCount: 0 }
    );
    expect(sendMocks.markQueued).not.toHaveBeenCalled();
  });

  it('keeps going when the worker already wrote the outcome before the queue write', async () => {
    sendMocks.markQueued.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledTimes(1);
  });

  it('prefixes the subject on a test send', async () => {
    mockFindAttemptById.mockResolvedValue(pendingAttempt({ testSubjectIndicator: true }));

    await run();

    expect(sendMocks.publish).toHaveBeenCalledWith(expect.objectContaining({ subject: '[TEST] Hi Ada Lovelace' }));
  });

  it('retries a publish that fails and marks the attempt queued once one goes through', async () => {
    sendMocks.publish.mockRejectedValueOnce(new Error('bus unreachable'));

    await run();

    expect(sendMocks.publish).toHaveBeenCalledTimes(2);
    expect(sendMocks.markQueued).toHaveBeenCalledWith('attempt-1', expect.objectContaining({ retryCount: 1 }));
  });

  it('marks the attempt failed when every publish is rejected', async () => {
    sendMocks.publish.mockRejectedValue(new Error('bus unreachable'));

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledTimes(3);
    expect(sendMocks.markSendFailed).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        errorMessage: expect.stringContaining('Failed after 3 attempts'),
        retryCount: 3,
      })
    );
    expect(sendMocks.smtpSendEmail).not.toHaveBeenCalled();
    expect(sendMocks.markQueued).not.toHaveBeenCalled();
  });

  it('marks the attempt failed when the bus rejects the entry without throwing', async () => {
    sendMocks.publish.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }],
    });

    await run();

    expect(sendMocks.publish).toHaveBeenCalledTimes(3);
    expect(sendMocks.markSendFailed).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ errorMessage: expect.stringContaining('Failed after 3 attempts') })
    );
  });
  it('sends once when the status write fails after the mail was accepted, retrying only the write', async () => {
    sendMocks.markQueued.mockRejectedValueOnce(new Error('write conflict')).mockResolvedValue(true);

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).toHaveBeenCalledTimes(1);
    expect(sendMocks.markQueued).toHaveBeenCalledTimes(2);
    expect(sendMocks.markSendFailed).not.toHaveBeenCalled();
  });

  it('keeps one send and fails the record when every status write fails, leaving a sent marker', async () => {
    sendMocks.markQueued.mockRejectedValue(new Error('db unavailable'));

    await expect(run()).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });

    expect(sendMocks.publish).toHaveBeenCalledTimes(1);
    expect(sendMocks.markQueued).toHaveBeenCalledTimes(3);
    expect(sendMocks.markSendAccepted).toHaveBeenCalledExactlyOnceWith('attempt-1', {
      at: expect.any(Date),
      queued: true,
    });
    expect(sendMocks.markSendFailed).not.toHaveBeenCalled();
  });

  it('finishes the status write for a redelivered attempt whose mail was already accepted, without sending', async () => {
    const acceptedAt = new Date('2026-01-02T00:00:00Z');
    mockFindAttemptById.mockResolvedValue(
      pendingAttempt({ status: EmailSendStatus.PROCESSING, sendAccepted: { at: acceptedAt, queued: true } })
    );

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).not.toHaveBeenCalled();
    expect(sendMocks.claimForSend).not.toHaveBeenCalled();
    expect(sendMocks.markQueued).toHaveBeenCalledExactlyOnceWith('attempt-1', { sentAt: acceptedAt, retryCount: 0 });
  });

  it('sends a stale PROCESSING attempt on redelivery once its lease is reclaimed', async () => {
    mockFindAttemptById.mockResolvedValue(pendingAttempt({ status: EmailSendStatus.PROCESSING }));

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.claimForSend).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ staleBefore: expect.any(Date) })
    );
    expect(sendMocks.publish).toHaveBeenCalledTimes(1);
    expect(sendMocks.markQueued).toHaveBeenCalledTimes(1);
  });

  it('does not send an attempt another invocation holds, and fails the record so it is retried', async () => {
    mockFindAttemptById.mockResolvedValue(pendingAttempt({ status: EmailSendStatus.PROCESSING }));
    sendMocks.claimForSend.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });

    expect(sendMocks.publish).not.toHaveBeenCalled();
    expect(sendMocks.markQueued).not.toHaveBeenCalled();
    expect(sendMocks.markSendFailed).not.toHaveBeenCalled();
  });

  it('skips an attempt that moved on before it could be claimed', async () => {
    sendMocks.claimForSend.mockResolvedValue(false);
    mockFindAttemptById
      .mockResolvedValueOnce(pendingAttempt())
      .mockResolvedValue(pendingAttempt({ status: EmailSendStatus.QUEUED }));

    await expect(run()).resolves.toEqual({ batchItemFailures: [] });

    expect(sendMocks.publish).not.toHaveBeenCalled();
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
