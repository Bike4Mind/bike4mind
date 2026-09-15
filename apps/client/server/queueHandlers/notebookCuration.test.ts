import { describe, it, expect, vi, beforeEach } from 'vitest';

// Idempotency contract: SQS is at-least-once, so a redelivered curation message
// must NOT re-run the LLM curation. The handler records a NotebookCurationJob
// with status 'completed' (keyed by curationJobId) once curation succeeds, and
// on redelivery no-ops if that record exists. Failures are deliberately NOT
// recorded so SQS's native retry/DLQ still applies.

// Hoisted so the vi.mock factories (which are themselves hoisted) can close over them.
const { mockCurateNotebook, mockSendToClient, NotebookCurationJob, Session, User } = vi.hoisted(() => ({
  mockCurateNotebook: vi.fn(),
  mockSendToClient: vi.fn(),
  NotebookCurationJob: { findOne: vi.fn(), updateOne: vi.fn() },
  Session: { findById: vi.fn() },
  User: { findById: vi.fn() },
}));

// Benign proxy so `Resource.X.value` / `Resource.App.stage` resolve to strings
// without touching real SST resources (mirrors videoGeneration.test.ts).
vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      if (key === 'then') return undefined;
      return new Proxy(
        {},
        {
          get(_inner, innerKey) {
            if (innerKey === 'then') return undefined;
            return `mock-${String(innerKey)}`;
          },
        }
      );
    },
  }),
}));

vi.mock('@bike4mind/database', () => ({
  Session,
  User,
  NotebookCurationJob,
  sessionRepository: {},
  questRepository: {},
  fabFileRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/services', () => ({
  notebookCurationService: {
    NotebookCurationService: class MockNotebookCurationService {
      constructor(_opts: unknown) {}
      curateNotebook(...args: unknown[]) {
        return mockCurateNotebook(...args);
      }
    },
  },
}));

vi.mock('@server/websocket/utils', () => ({
  sendToClient: (...args: unknown[]) => mockSendToClient(...args),
}));

vi.mock('@server/utils/eventBus', () => ({
  NotebookCurationEvents: {
    Complete: { publish: vi.fn().mockResolvedValue(undefined) },
    Error: { publish: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({
    getSignedUrl: vi.fn(),
    upload: vi.fn(),
  })),
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: any = {
    info: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  };
  mockLogger.withMetadata = vi.fn(() => mockLogger);
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

import { dispatch } from './notebookCuration';

const mockContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test-notebookCuration',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/test',
  logStreamName: 'test-stream',
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
} as any;

const createEvent = (payload: Record<string, unknown>) =>
  ({
    Records: [
      {
        messageId: 'test-message-id',
        receiptHandle: 'test-receipt-handle',
        body: JSON.stringify(payload),
        attributes: {
          ApproximateReceiveCount: '2', // redelivery
          SentTimestamp: '1234567890',
          SenderId: 'test-sender',
          ApproximateFirstReceiveTimestamp: '1234567890',
        },
        messageAttributes: {},
        md5OfBody: 'test-md5',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-queue',
        awsRegion: 'us-east-1',
      },
    ],
  }) as any;

const basePayload = {
  sessionId: 'session-123',
  userId: 'user-456',
  curationJobId: 'job-789',
};

describe('notebookCuration queue handler idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Session.findById.mockResolvedValue({ _id: 'session-123', userId: 'user-456' });
    User.findById.mockResolvedValue({ _id: 'user-456' });
    NotebookCurationJob.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    NotebookCurationJob.updateOne.mockResolvedValue({ acknowledged: true });
    mockCurateNotebook.mockResolvedValue({
      success: true,
      curatedFileId: 'file-1',
      fileName: 'notebook.md',
      fileSize: 1024,
      artifactCount: 1,
      messageCount: 2,
      tokensProcessed: 3,
      tokensDeducted: 100,
    });
  });

  it('skips a redelivered message whose curation job already completed', async () => {
    NotebookCurationJob.findOne.mockReturnValue({
      lean: () => Promise.resolve({ curationJobId: 'job-789', sessionId: 'session-123', status: 'completed' }),
    });

    await dispatch(createEvent(basePayload), mockContext);

    expect(NotebookCurationJob.findOne).toHaveBeenCalledWith({ curationJobId: 'job-789' });
    expect(mockCurateNotebook).not.toHaveBeenCalled();
    expect(mockSendToClient).not.toHaveBeenCalled();
  });

  it('processes a fresh message when no prior curation job record exists', async () => {
    NotebookCurationJob.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await dispatch(createEvent(basePayload), mockContext);

    expect(mockCurateNotebook).toHaveBeenCalledTimes(1);
  });

  it('records a terminal completed status after a successful curation', async () => {
    NotebookCurationJob.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await dispatch(createEvent(basePayload), mockContext);

    expect(NotebookCurationJob.updateOne).toHaveBeenCalledWith(
      { curationJobId: 'job-789' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'completed' }),
      }),
      expect.objectContaining({ upsert: true })
    );
  });

  it('does NOT record a status when curation throws, so SQS can retry', async () => {
    NotebookCurationJob.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCurateNotebook.mockRejectedValue(new Error('curation boom'));

    // Re-throws so SQS retries the message and eventually routes it to the DLQ.
    await expect(dispatch(createEvent(basePayload), mockContext)).rejects.toThrow();

    // No idempotency record is written on failure - a redelivery must be free
    // to re-attempt (transient-failure resilience), not silently skipped.
    expect(NotebookCurationJob.updateOne).not.toHaveBeenCalled();
  });
});
