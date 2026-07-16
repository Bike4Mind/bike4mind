import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@bike4mind/utils';

vi.mock('sst', () => ({
  Resource: {
    MONGODB_URI: { value: 'mongodb://fake' },
    App: { stage: 'test' },
    emailAnalysisQueue: { url: 'https://fake-queue.example/queue' },
  },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  userRepository: {},
  ingestedEmailRepository: {},
  fabFileRepository: {},
  adminSettingsRepository: {},
}));

const mockProcessIngestedEmail = vi.fn();
vi.mock('@bike4mind/services', () => ({
  emailIngestionService: {
    processIngestedEmail: (...args: unknown[]) => mockProcessIngestedEmail(...args),
  },
}));

const mockSimpleParser = vi.fn();
vi.mock('mailparser', () => ({
  simpleParser: (...args: unknown[]) => mockSimpleParser(...args),
}));

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(...args: unknown[]) {
      return mockS3Send(...args);
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: vi.fn(),
}));

import { dispatch } from './emailParser';

function s3Body(content: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(content);
    },
  };
}

function makeSqsRecord(messageId: string, key: string) {
  return {
    messageId,
    body: JSON.stringify({
      Records: [{ s3: { bucket: { name: 'email-bucket' }, object: { key } } }],
    }),
  };
}

const parsedMail = {
  messageId: 'mail-1',
  subject: 'Test',
  text: 'hello',
  html: false,
  attachments: [],
};

const ingestResult = {
  emailId: 'email-1',
  messageId: 'mail-1',
  threadId: 'thread-1',
  attachments: [],
  bodyFabFileCreated: false,
  alreadyProcessed: false,
};

describe('emailParser dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSimpleParser.mockResolvedValue(parsedMail);
  });

  it('reports only the failing record in batchItemFailures, still processing the rest', async () => {
    mockS3Send.mockImplementation(async (command: { input: { Key: string } }) => {
      if (command.input.Key === 'bad-key') {
        throw new Error('s3 download failed');
      }
      return { Body: s3Body('raw email bytes') };
    });
    mockProcessIngestedEmail.mockResolvedValue(ingestResult);

    const event = {
      Records: [makeSqsRecord('msg-good', 'good-key'), makeSqsRecord('msg-bad', 'bad-key')],
    } as never;

    const result = await dispatch(event, {} as never, undefined as never);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-bad' }] });
    expect(mockProcessIngestedEmail).toHaveBeenCalledTimes(1);
  });

  it('returns an empty batchItemFailures when every record succeeds', async () => {
    mockS3Send.mockResolvedValue({ Body: s3Body('raw email bytes') });
    mockProcessIngestedEmail.mockResolvedValue(ingestResult);

    const event = {
      Records: [makeSqsRecord('msg-1', 'key-1'), makeSqsRecord('msg-2', 'key-2')],
    } as never;

    const result = await dispatch(event, {} as never, undefined as never);

    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('swallows an UnauthorizedError instead of reporting it as a batch failure', async () => {
    mockS3Send.mockResolvedValue({ Body: s3Body('raw email bytes') });
    mockProcessIngestedEmail.mockRejectedValueOnce(new UnauthorizedError('sender not authorized'));

    const event = {
      Records: [makeSqsRecord('msg-unauthorized', 'key-1')],
    } as never;

    const result = await dispatch(event, {} as never, undefined as never);

    expect(result).toEqual({ batchItemFailures: [] });
  });
});
