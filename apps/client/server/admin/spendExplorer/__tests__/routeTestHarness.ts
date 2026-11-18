import { vi } from 'vitest';

/**
 * Shared mocks for the spend-explorer route tests: a baseApi stub that records the
 * route config and GET handler, and a mongoose-style query chain for model finds.
 */

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

export function baseApiStub(config?: unknown) {
  const handlers: Record<string, Handler> = {};
  const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
  const chain = async (req: { method: string }, res: unknown) => {
    for (const middleware of middlewares) await middleware(req, res, () => undefined);
    return handlers[req.method](req, res);
  };
  chain.use = (middleware: (typeof middlewares)[number]) => {
    middlewares.push(middleware);
    return chain;
  };
  chain.get = (fn: Handler) => {
    handlers.GET = fn;
    return chain;
  };
  chain._config = config;
  return chain;
}

/** `Model.find(filter)` returning a chain whose `.lean()` resolves to `rows`. */
export function findReturning(rows: unknown[]) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    maxTimeMS: () => query,
    lean: () => Promise.resolve(rows),
  };
  return vi.fn(() => query);
}

export const NON_ADMIN_USER = { isAdmin: false, id: 'user-1' };

/**
 * Run a GET against a route (as a full admin unless `user` says otherwise), capturing a thrown
 * error instead of the JSON body.
 */
export async function runGet<Body>(
  handler: unknown,
  query: Record<string, string>,
  user: Record<string, unknown> = { isAdmin: true, id: 'admin-1' }
) {
  const { createMocks } = await import('node-mocks-http');
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, {
    user,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  let thrown: unknown;
  try {
    await (handler as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  } catch (error) {
    thrown = error;
  }
  return { thrown, body: thrown ? undefined : (res._getJSONData() as Body) };
}
