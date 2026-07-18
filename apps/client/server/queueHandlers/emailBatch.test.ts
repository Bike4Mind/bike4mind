import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailJobStatus } from '@bike4mind/common';

// Passthrough so `dispatch` is the raw (event, ctx, logger) handler - the queue is
// subscribed with batch.partialResponses: true, so dispatch's return value (the
// batchItemFailures contract) is what SQS actually reads.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const mockFindJobById = vi.fn();
const mockFindTemplateById = vi.fn();
const mockFindAttemptById = vi.fn();
const mockIncrementCountsBy = vi.fn();
const mockUpdateJob = vi.fn();
const mockCountAttempts = vi.fn();

vi.mock('@bike4mind/database', () => ({
  emailJobRepository: {
    findById: (...args: unknown[]) => mockFindJobById(...args),
    incrementCountsBy: (...args: unknown[]) => mockIncrementCountsBy(...args),
    update: (...args: unknown[]) => mockUpdateJob(...args),
  },
  emailSendAttemptRepository: {
    findById: (...args: unknown[]) => mockFindAttemptById(...args),
    count: (...args: unknown[]) => mockCountAttempts(...args),
  },
  emailTemplateRepository: {
    findById: (...args: unknown[]) => mockFindTemplateById(...args),
  },
  userRepository: { findById: vi.fn() },
  subscriberRepository: { findById: vi.fn() },
}));

vi.mock('@server/utils/mailer', () => ({
  default: { sendEmail: vi.fn() },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

import { dispatch } from './emailBatch';

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
