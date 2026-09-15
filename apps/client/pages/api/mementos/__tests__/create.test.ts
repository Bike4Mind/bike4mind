import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mementoCreateMock, findByUserIdMock, getEffectiveLLMApiKeysMock, generateEmbeddingMock } = vi.hoisted(() => ({
  mementoCreateMock: vi.fn(),
  findByUserIdMock: vi.fn(),
  getEffectiveLLMApiKeysMock: vi.fn(),
  generateEmbeddingMock: vi.fn(),
}));

// baseApi().post(fn) returns the inner handler directly so we can call it with a fake req/res.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', () => ({
  Memento: { create: mementoCreateMock, findByUserId: findByUserIdMock },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: getEffectiveLLMApiKeysMock } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/utils/mementoEmbedding', () => ({ generateMementoSummaryEmbedding: generateEmbeddingMock }));
vi.mock('../../../../services/MementoGroomingService', () => ({
  MementoGroomingService: vi.fn(function () {
    return { checkAndScheduleGrooming: vi.fn().mockResolvedValue(undefined) };
  }),
  MEMORY_LIMITS: { DEFAULT_MAX_TOTAL_CHARS: 1_000_000 },
  calculateHotMementoSize: () => 0,
}));
vi.mock('@server/validators/mementoValidators', () => ({ CreateMementoSchema: { parse: (b: unknown) => b } }));

const handler = (await import('../create')).default as (req: Request, res: Response) => Promise<unknown>;

const makeRes = () => {
  const res = { statusCode: 0, body: undefined as unknown } as unknown as Response & {
    statusCode: number;
    body: unknown;
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
};

const makeReq = () =>
  ({
    user: { id: 'u1' },
    logger: { updateMetadata: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    body: {
      type: 'prompt',
      tier: 'hot',
      weight: 500,
      sessionId: 's1',
      summary: 'I prefer TypeScript',
      fullContent: 'full',
      tags: ['pref'],
    },
  }) as unknown as Request;

describe('POST /api/mementos/create embedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUserIdMock.mockResolvedValue([]);
    getEffectiveLLMApiKeysMock.mockResolvedValue({ openai: 'sk-test', ollama: null });
    mementoCreateMock.mockResolvedValue({ id: 'm1', tier: 'hot', weight: 0.5 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('embeds the summary and passes the vector to Memento.create', async () => {
    generateEmbeddingMock.mockResolvedValue([0.1, 0.2, 0.3]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(generateEmbeddingMock).toHaveBeenCalledWith(
      'I prefer TypeScript',
      expect.objectContaining({ apiKeyTable: { openai: 'sk-test', ollama: null } })
    );
    expect(mementoCreateMock).toHaveBeenCalledTimes(1);
    expect(mementoCreateMock.mock.calls[0][0]).toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      summary: 'I prefer TypeScript',
    });
  });

  it('creates the memento without an embedding field when embedding is null', async () => {
    generateEmbeddingMock.mockResolvedValue(null);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mementoCreateMock).toHaveBeenCalledTimes(1);
    expect('embedding' in mementoCreateMock.mock.calls[0][0]).toBe(false);
  });
});
