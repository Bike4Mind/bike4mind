import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';

const { mementoCreateMock, findByUserIdMock } = vi.hoisted(() => ({
  mementoCreateMock: vi.fn(),
  findByUserIdMock: vi.fn(),
}));

// baseApi().post(fn) returns the inner handler directly so we can call it with a fake req/res.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', () => ({
  Memento: { create: mementoCreateMock, findByUserId: findByUserIdMock },
}));
vi.mock('../../../../services/MementoGroomingService', () => ({
  MementoGroomingService: vi.fn(function () {
    return { checkAndScheduleGrooming: vi.fn().mockResolvedValue(undefined) };
  }),
  MEMORY_LIMITS: { DEFAULT_MAX_TOTAL_CHARS: 1_000_000 },
  calculateHotMementoSize: () => 0,
}));
vi.mock('@server/validators/mementoValidators', () => ({
  CreateMementoSchema: { array: () => ({ parse: (b: unknown) => b }) },
}));

const handler = (await import('../create-batch')).default as (req: Request, res: Response) => Promise<unknown>;

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
    body: [{ type: 'prompt', tier: 'hot', weight: 500, sessionId: 's1', summary: 'I prefer TypeScript' }],
  }) as unknown as Request;

describe('POST /api/mementos/create-batch client errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUserIdMock.mockResolvedValue([]);
  });

  it('answers 400 naming the failing path when the model rejects a memento', async () => {
    mementoCreateMock.mockRejectedValue(
      Object.assign(new Error("Memento validation failed: fullContent: Path 'fullContent' is required."), {
        name: 'ValidationError',
        errors: { fullContent: {} },
      })
    );
    const req = makeReq();
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid memento: fullContent' });
    expect(req.logger.error).not.toHaveBeenCalled();
  });

  it('rethrows a ZodError so the shared error handler answers it', async () => {
    const zodError = z.string().safeParse(1).error;
    mementoCreateMock.mockRejectedValue(zodError);

    await expect(handler(makeReq(), makeRes())).rejects.toBe(zodError);
  });

  it('still answers 500 and logs at error level for an unexpected failure', async () => {
    mementoCreateMock.mockRejectedValue(new Error('db down'));
    const req = makeReq();
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(req.logger.error).toHaveBeenCalled();
  });
});
