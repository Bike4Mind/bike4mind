import { vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

/**
 * Stands in for baseApi: runs the `.use` middlewares (adminApi's permission check among them) and
 * then the method's handler, so a refusal surfaces as the thrown error the real error handler maps.
 */
export const fakeBaseApi = (config: unknown) => {
  const handlers: Record<string, Handler> = {};
  const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
  const chain = Object.assign(
    async (req: { method?: string }, res: unknown) => {
      for (const middleware of middlewares) await middleware(req, res, () => undefined);
      return handlers[req.method ?? 'GET']?.(req, res);
    },
    {
      use: (middleware: (typeof middlewares)[number]) => (middlewares.push(middleware), chain),
      get: (fn: Handler) => ((handlers.GET = fn), chain),
      post: (fn: Handler) => ((handlers.POST = fn), chain),
      patch: (fn: Handler) => ((handlers.PATCH = fn), chain),
      delete: (fn: Handler) => ((handlers.DELETE = fn), chain),
      _config: config,
    }
  );
  return chain;
};

export const FULL_ADMIN = { id: 'a'.repeat(24), isAdmin: true };
export const SUPPORT_DELEGATE = { id: 'b'.repeat(24), isAdmin: false, adminPermissions: ['support:read'] };
export const ROLE_ONLY_SUPPORT = {
  id: 'c'.repeat(24),
  isAdmin: false,
  adminPermissions: [],
  adminRoleIds: ['e'.repeat(24)],
  roleAdminPermissions: ['support:read'],
};
export const NON_ADMIN = { id: 'd'.repeat(24), isAdmin: false, adminPermissions: [] };

export async function call(
  handler: unknown,
  method: RequestMethod,
  user: object,
  options: { query?: Record<string, string>; body?: Record<string, unknown> } = {}
) {
  const { req, res } = createMocks({ method, query: options.query, body: options.body });
  Object.assign(req, { user });
  await (handler as Handler)(req, res);
  return res;
}

export const passthroughMiddleware = () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
