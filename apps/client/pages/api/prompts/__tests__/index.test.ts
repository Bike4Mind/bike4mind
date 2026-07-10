import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockCreatePrompt } = vi.hoisted(() => ({
  mockCreatePrompt: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  Prompt: class Prompt {},
  promptRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  promptService: { createPrompt: (...a: unknown[]) => mockCreatePrompt(...a) },
}));

import handler from '../index';

const CREATE_BODY = { type: 'system', name: 'x', promptText: 'hello' };

const run = ({
  ability,
  body = CREATE_BODY,
}: {
  ability?: { can: (a: string, s: unknown) => boolean };
  body?: unknown;
}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  if (ability !== undefined) (req as Record<string, unknown>).ability = ability;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockCreatePrompt.mockReset().mockResolvedValue({ id: 'p1' });
});

describe('POST /api/prompts - create permission', () => {
  it('rejects when req.ability is absent', async () => {
    const { promise } = run({ ability: undefined });
    await expect(promise).rejects.toThrow();
    expect(mockCreatePrompt).not.toHaveBeenCalled();
  });

  it('rejects a caller whose ability denies create on Prompt', async () => {
    const { promise } = run({ ability: { can: () => false } });
    await expect(promise).rejects.toThrow();
    expect(mockCreatePrompt).not.toHaveBeenCalled();
  });

  it('creates the prompt when the ability grants create on Prompt', async () => {
    const { res, promise } = run({ ability: { can: () => true } });
    await promise;
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreatePrompt).toHaveBeenCalledWith(
      { type: 'system', name: 'x', promptText: 'hello', tags: [] },
      expect.anything()
    );
  });
});
