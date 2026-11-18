// @vitest-environment node
/** /api/v1/assistant/instructions: owner-scoped list/create/delete, the per-user cap, and 404 for anything not yours. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { INSTRUCTION_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  listByUser: vi.fn(),
  createWithinCap: vi.fn(),
  deleteOwned: vi.fn(),
  baseApiOptions: [] as { auth?: unknown }[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (code: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: (options: { auth?: unknown }) => {
    h.baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    chain.post = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/database', () => ({
  assistantInstructionRepository: {
    listByUser: h.listByUser,
    createWithinCap: h.createWithinCap,
    deleteOwned: h.deleteOwned,
  },
}));

const { default: collection } = await import('../index');
const { default: item } = await import('../[id]');

const USER_ID = '64b0000000000000000000a1';
const INSTRUCTION_ID = '64b000000000000000000001';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
const user = { id: USER_ID };

const doc = (text: string, id = INSTRUCTION_ID) => ({
  _id: { toString: () => id },
  userId: USER_ID,
  text,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
});

type Handler = (req: unknown, res: unknown) => Promise<void>;

async function run(handler: unknown, opts: Parameters<typeof createMocks>[0]) {
  const { req, res } = createMocks(opts);
  Object.assign(req, { user, logger, headers: {} });
  await (handler as Handler)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createWithinCap.mockImplementation(async ({ text }: { text: string }) => doc(text));
});

describe('auth', () => {
  it('builds every route JWT-only, so an API key never reaches a handler', () => {
    expect(h.baseApiOptions.length).toBeGreaterThanOrEqual(3);
    for (const options of h.baseApiOptions) expect(options.auth).toBe('jwtOnly');
  });
});

describe('GET /api/v1/assistant/instructions', () => {
  it('lists only the caller instructions', async () => {
    h.listByUser.mockResolvedValue([doc('lead with invoices')]);
    const res = await run(collection, { method: 'GET' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.listByUser).toHaveBeenCalledWith(USER_ID);
    expect(res._getJSONData()).toEqual({
      instructions: [{ id: INSTRUCTION_ID, text: 'lead with invoices', createdAt: '2026-11-01T00:00:00.000Z' }],
    });
  });
});

describe('POST /api/v1/assistant/instructions', () => {
  it('saves trimmed text for the caller with 201', async () => {
    const res = await run(collection, { method: 'POST', body: { text: '  lead with invoices  ' } });
    expect(res._getStatusCode()).toBe(201);
    expect(h.createWithinCap).toHaveBeenCalledWith({ userId: USER_ID, text: 'lead with invoices' }, 20);
    expect(res._getJSONData().text).toBe('lead with invoices');
  });

  it('refuses a save past the cap with instruction_limit_reached', async () => {
    h.createWithinCap.mockResolvedValue(null);
    await expect(run(collection, { method: 'POST', body: { text: 'one more' } })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { errorCode: INSTRUCTION_LIMIT_REACHED_ERROR_CODE },
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['over 280 characters', 'x'.repeat(281)],
    ['not a string', 42],
  ])('rejects %s text before writing', async (_label, text) => {
    await expect(run(collection, { method: 'POST', body: { text } })).rejects.toMatchObject({ name: 'ZodError' });
    expect(h.createWithinCap).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/assistant/instructions/{id}', () => {
  it('removes an owned instruction with 204', async () => {
    h.deleteOwned.mockResolvedValue(true);
    const res = await run(item, { method: 'DELETE', query: { id: INSTRUCTION_ID } });
    expect(res._getStatusCode()).toBe(204);
    expect(h.deleteOwned).toHaveBeenCalledWith(USER_ID, INSTRUCTION_ID);
  });

  it.each([
    ['another user instruction or a missing one', INSTRUCTION_ID],
    ['a malformed id', 'not-an-id'],
  ])('answers 404 for %s', async (_label, id) => {
    h.deleteOwned.mockResolvedValue(false);
    await expect(run(item, { method: 'DELETE', query: { id } })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.deleteOwned).toHaveBeenCalledWith(USER_ID, id);
  });
});
