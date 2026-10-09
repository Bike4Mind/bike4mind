// @vitest-environment node
/**
 * Characterization tests for POST /api/ai/transcribe: pin the legacy key-ownership check, the
 * S3-attested HEAD validation, the credit check, provider dispatch, billing and the S3 delete that
 * runs on success and on failure. The AWS SDK, `sst`, the database, the services and the
 * operations-model lookup are mocked by module specifier so the mocks keep biting wherever the
 * route's body lives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockSend, mockFindUser, mockGetOperationsModel, mockGetApiKey, mockOpenAI, mockAWS, mockSubtractCredits } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockFindUser: vi.fn(),
    mockGetOperationsModel: vi.fn(),
    mockGetApiKey: vi.fn(),
    mockOpenAI: vi.fn(),
    mockAWS: vi.fn(),
    mockSubtractCredits: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: unknown) => handler;
    return chain;
  },
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockSend;
  },
  HeadObjectCommand: class {
    kind = 'head';
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    kind = 'delete';
    constructor(public input: unknown) {}
  },
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mockGetOperationsModel },
  getEffectiveApiKeyByBackend: mockGetApiKey,
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mockFindUser },
  creditTransactionRepository: {},
  usageEventRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    speechToTextService: {
      ...actual.speechToTextService,
      speechService: class {
        transcribeOpenAIFromS3 = mockOpenAI;
        transcribeAWSFromS3 = mockAWS;
      },
    },
    creditService: { subtractCredits: mockSubtractCredits },
  };
});

const { default: handler } = await import('../index');

const KEY = 'transcribe-uploads/u1/abc.mp3';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
const call = (req: unknown, res: unknown) => (handler as any)(req, res);

async function rejection(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    return err as { statusCode?: number; message: string };
  }
  throw new Error('expected the handler to throw');
}

const sentDeletes = () =>
  mockSend.mock.calls.map(([cmd]) => cmd as { kind: string; input: unknown }).filter(cmd => cmd.kind === 'delete');

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'head' ? { ContentType: 'audio/mpeg', ContentLength: 1_000_000 } : {}
  );
  mockFindUser.mockResolvedValue({ id: 'u1', currentCredits: 10 });
  mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'openai', id: 'whisper-1' } });
  mockGetApiKey.mockResolvedValue('sk-test');
  mockOpenAI.mockResolvedValue({ text: 'hello world' });
  mockAWS.mockResolvedValue({ text: 'hello aws' });
  mockSubtractCredits.mockResolvedValue(undefined);
});

describe('POST /api/ai/transcribe', () => {
  it('transcribes, bills by size, returns { text } and deletes the upload', async () => {
    const { req, res } = post({ fileKey: KEY });

    await call(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ text: 'hello world' });
    expect(mockOpenAI).toHaveBeenCalledWith(KEY, 'audio/mpeg', { backend: 'openai', id: 'whisper-1' }, 'sk-test');
    expect(mockSubtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speech_to_text_usage', ownerId: 'u1', model: 'openai' }),
      expect.anything()
    );
    expect(sentDeletes()).toEqual([expect.objectContaining({ input: { Bucket: 'test-bucket', Key: KEY } })]);
  });

  it('dispatches to the AWS backend without an API key', async () => {
    mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'aws' } });
    mockGetApiKey.mockResolvedValue(undefined);
    const { req, res } = post({ fileKey: KEY });

    await call(req, res);

    expect(res._getJSONData()).toEqual({ text: 'hello aws' });
    expect(mockAWS).toHaveBeenCalledWith(KEY, 'audio/mpeg');
  });

  it('still returns the text when billing fails', async () => {
    mockSubtractCredits.mockRejectedValue(new Error('billing down'));
    const { req, res } = post({ fileKey: KEY });

    await call(req, res);

    expect(res._getJSONData()).toEqual({ text: 'hello world' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects a bad body with 400 and touches nothing', async () => {
    const { req, res } = post({ fileKey: '' });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/^Invalid request: /);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects a key outside the caller's prefix with 400 and touches nothing", async () => {
    const { req, res } = post({ fileKey: 'transcribe-uploads/u2/abc.mp3' });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Invalid file key');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a missing upload with 400 and still deletes', async () => {
    mockSend.mockImplementation(async (cmd: { kind: string }) => {
      if (cmd.kind === 'head') throw new Error('NotFound');
      return {};
    });
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Uploaded file not found or expired');
    expect(sentDeletes()).toHaveLength(1);
  });

  it.each([
    ['an unsupported stored type', { ContentType: 'video/mp4', ContentLength: 10 }, 'Unsupported file type: video/mp4'],
    ['an empty object', { ContentType: 'audio/mpeg', ContentLength: 0 }, 'File size out of range'],
  ])('rejects %s with 400', async (_label, head, message) => {
    mockSend.mockImplementation(async (cmd: { kind: string }) => (cmd.kind === 'head' ? head : {}));
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(message);
    expect(mockOpenAI).not.toHaveBeenCalled();
    expect(sentDeletes()).toHaveLength(1);
  });

  it('rejects a caller with no credits with 400 before transcribing', async () => {
    mockFindUser.mockResolvedValue({ id: 'u1', currentCredits: 0 });
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Insufficient credits for transcription');
    expect(mockOpenAI).not.toHaveBeenCalled();
    expect(sentDeletes()).toHaveLength(1);
  });

  it('rejects an unconfigured speech model with 400', async () => {
    mockGetOperationsModel.mockResolvedValue({});
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/^Speech model not configured/);
  });

  it('rejects a missing provider API key with 400', async () => {
    mockGetApiKey.mockResolvedValue(undefined);
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('API key not configured for openai backend');
  });

  it('rethrows a provider failure unchanged, deletes the upload and bills nothing', async () => {
    const failure = new Error('provider exploded');
    mockOpenAI.mockRejectedValue(failure);
    const { req, res } = post({ fileKey: KEY });

    const err = await rejection(call(req, res));

    expect(err).toBe(failure);
    expect(mockSubtractCredits).not.toHaveBeenCalled();
    expect(sentDeletes()).toHaveLength(1);
  });
});
