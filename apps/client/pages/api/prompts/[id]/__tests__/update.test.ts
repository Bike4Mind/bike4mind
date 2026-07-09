import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockUpdatePrompt } = vi.hoisted(() => ({
  mockUpdatePrompt: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PUT']?.(req, res),
      {
        use: () => chain,
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  Prompt: class Prompt {},
  promptRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  promptService: { updatePrompt: (...a: unknown[]) => mockUpdatePrompt(...a) },
}));

import handler from '../update';

const run = ({
  ability,
  id = 'p1',
  body = {},
}: {
  ability?: { can: (action: string, subject: unknown) => boolean };
  id?: string;
  body?: Record<string, unknown>;
} = {}) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id }, body });
  if (ability !== undefined) (req as Record<string, unknown>).ability = ability;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUpdatePrompt.mockReset().mockResolvedValue({ id: 'p1', promptText: 'updated' });
});

describe('PUT /api/prompts/:id/update', () => {
  it('rejects when req.ability is absent', async () => {
    const { promise } = run();
    await expect(promise).rejects.toThrow();
    expect(mockUpdatePrompt).not.toHaveBeenCalled();
  });

  it('rejects when the ability denies update on Prompt', async () => {
    const { promise } = run({ ability: { can: () => false } });
    await expect(promise).rejects.toThrow();
    expect(mockUpdatePrompt).not.toHaveBeenCalled();
  });

  it('allows the update when the ability grants update on Prompt', async () => {
    const { res, promise } = run({ ability: { can: () => true }, body: { promptText: 'updated' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdatePrompt).toHaveBeenCalledWith(
      { id: 'p1', promptText: 'updated' },
      expect.objectContaining({ db: expect.anything() })
    );
  });
});
