import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route answers "will this attachment reach the model", so what matters here is that it measures
 * the right thing, refuses a file the caller cannot see, and does NOT reach into the completion
 * pipeline to find out. The budget arithmetic itself is covered in contextBudget.test.ts; these assert
 * the route's own decisions.
 */

const mockListFabFiles = vi.fn();
const mockGetFileContent = vi.fn();
const mockUpdate = vi.fn(async () => null);

vi.mock('@bike4mind/database/content', () => ({
  fabFileRepository: { update: (...a: unknown[]) => mockUpdate(...a) },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/database/infra', () => ({ adminSettingsRepository: {} }));

// Only listFabFiles may be reached on this barrel. A future edit that wires the feature pipeline in
// here would call something else on it and fail the guard test below.
const servicesTouched: string[] = [];
vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    listFabFiles: (...a: unknown[]) => {
      servicesTouched.push('fabFilesService.listFabFiles');
      return mockListFabFiles(...a);
    },
  },
  get mementoService() {
    servicesTouched.push('mementoService');
    return {};
  },
  get sessionService() {
    servicesTouched.push('sessionService');
    return {};
  },
}));

vi.mock('@bike4mind/utils', async importOriginal => ({
  // Real budget arithmetic: stubbing it would make every figure below meaningless.
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getFileContent: (...a: unknown[]) => mockGetFileContent(...a),
}));

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn(async () => 'https://x') }) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));

// Llama 4 Maverick: 8000 window, 2048 reserved output.
const LLAMA_8K = { contextWindow: 8000, maxOutputTokens: 2048, requestedMaxTokens: 2048, modelType: 'text' };

const csv = (chars: number) => 'x'.repeat(chars);

const run = async (body: Record<string, unknown>) => {
  const handler = (await import('../context-dry-run')).default as unknown as (
    req: unknown,
    res: unknown
  ) => Promise<unknown>;
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as { user: unknown; logger: unknown }).user = { id: 'u1' };
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn(), info: vi.fn() };
  await handler(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

const file = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  fileName: 'budget.csv',
  mimeType: 'text/csv',
  filePath: 'fab-files/f1.csv',
  fileSize: 4000,
  // The serve gate fails closed, so a fixture that omits this is 'pending', not measurable.
  moderationStatus: 'clean',
  ...over,
});

describe('POST /api/ai/context-dry-run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    servicesTouched.length = 0;
  });

  // Guessing a window would produce a confident wrong answer, which is the failure mode a pre-send
  // warning must never have.
  it('refuses a request that does not say how big the model is', async () => {
    const { status } = await run({ fileIds: ['f1'] });

    expect(status).toBe(400);
    expect(mockListFabFiles).not.toHaveBeenCalled();
  });

  it('reports a 4,000-character file as fully delivered on an 8k model', async () => {
    mockListFabFiles.mockResolvedValue([file({ extractedCharCount: 4000 })]);

    const { status, body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(status).toBe(200);
    expect(body.files[0].deliveredFraction).toBe(1);
    expect(body.files[0].measured).toBe('extracted');
    // The whole point of the sibling PR: extraction now clears a 4k file on this window.
    expect(body.perFileBudgetTokens * 3.5).toBeGreaterThan(4000);
  });

  it('reports a file that will be cut as partially delivered', async () => {
    mockListFabFiles.mockResolvedValue([file({ extractedCharCount: 40_000, fileSize: 40_000 })]);

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(body.files[0].deliveredFraction).toBeLessThan(1);
    expect(body.files[0].deliveredFraction).toBeGreaterThan(0);
  });

  // An id the caller cannot see must not be measurable here either, or the route becomes a way to
  // probe someone else's files.
  it('measures only the files the ability-scoped read returned', async () => {
    mockListFabFiles.mockResolvedValue([file()]);

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1', 'someone-elses-file'] });

    expect(body.files.map((f: { id: string }) => f.id)).toEqual(['f1']);
    expect(mockListFabFiles).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      { ids: ['f1', 'someone-elses-file'] },
      expect.anything()
    );
  });

  it('extracts and writes the character count through when it was never measured', async () => {
    mockListFabFiles.mockResolvedValue([file()]);
    mockGetFileContent.mockResolvedValue(csv(4000));

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(mockGetFileContent).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'f1', extractedCharCount: 4000 });
    expect(body.files[0].extractedChars).toBe(4000);
  });

  it('does not download a file whose character count is already known', async () => {
    mockListFabFiles.mockResolvedValue([file({ extractedCharCount: 1234 })]);

    await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(mockGetFileContent).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // fileSize is a fair proxy for csv/text and useless for pdf/docx, so the answer has to say which
  // figure it used rather than presenting an estimate as a measurement.
  it('falls back to fileSize and says so when extraction fails', async () => {
    mockListFabFiles.mockResolvedValue([file()]);
    mockGetFileContent.mockRejectedValue(new Error('s3 down'));

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(body.files[0].measured).toBe('fileSize');
    expect(body.files[0].extractedChars).toBeUndefined();
  });

  // The extraction stage divides its budget by the text-file count, so a sibling attachment halves a
  // file's share. A warning calibrated on one file would be wrong for two.
  it('shrinks each file share as siblings are attached', async () => {
    mockListFabFiles.mockResolvedValue([
      file({ extractedCharCount: 4000 }),
      file({ id: 'f2', extractedCharCount: 4000 }),
    ]);

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1', 'f2'] });

    expect(body.textFileCount).toBe(2);
    expect(body.files[0].deliveredFraction).toBeLessThan(1);
  });

  it('treats an image as unaffected by the text budget', async () => {
    mockListFabFiles.mockResolvedValue([file({ mimeType: 'image/png', fileSize: 900_000 })]);

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(body.files[0].isImage).toBe(true);
    expect(body.files[0].deliveredFraction).toBe(1);
    expect(mockGetFileContent).not.toHaveBeenCalled();
  });

  // The serve gate holds every mime type until moderation completes, because the mimeType this route
  // would otherwise trust is client-declared and only corrected by the S3 scan a second or two later.
  // A file declared text/csv but actually an image must not be downloaded inside that window.
  it.each([['pending'], ['scanning'], ['blocked'], [null], [undefined]])(
    'refuses to read a file whose moderationStatus is %s',
    async status => {
      mockListFabFiles.mockResolvedValue([file({ moderationStatus: status })]);

      const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

      expect(mockGetFileContent).not.toHaveBeenCalled();
      expect(body.files[0].measured).toBe('pending');
      // Claims nothing about a size it refused to measure, so the banner stays quiet.
      expect(body.files[0].deliveredFraction).toBe(1);
    }
  );

  it('reads a file once moderation has cleared it', async () => {
    mockListFabFiles.mockResolvedValue([file({ moderationStatus: 'clean' })]);
    mockGetFileContent.mockResolvedValue(csv(4000));

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(mockGetFileContent).toHaveBeenCalledTimes(1);
    expect(body.files[0].measured).toBe('extracted');
  });

  // An already-persisted count came from a previous read, so it stays usable without re-downloading.
  it('still reports a previously measured count for a file now mid-rescan', async () => {
    mockListFabFiles.mockResolvedValue([file({ moderationStatus: 'scanning', extractedCharCount: 4000 })]);

    const { body } = await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect(mockGetFileContent).not.toHaveBeenCalled();
    expect(body.files[0].measured).toBe('extracted');
  });

  // A dry run must not shape later real completions. The pipeline features that would - mementos
  // writing durable user memory, context summarization writing session.contextSummary - are not
  // reachable from here, and this fails if a future edit wires them in.
  it('touches nothing on the services barrel but the ability-scoped file read', async () => {
    mockListFabFiles.mockResolvedValue([file({ extractedCharCount: 100 })]);

    await run({ ...LLAMA_8K, fileIds: ['f1'] });

    expect([...new Set(servicesTouched)]).toEqual(['fabFilesService.listFabFiles']);
  });
});
