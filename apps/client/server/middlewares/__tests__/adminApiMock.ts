// Shared vi.mock factory for admin route tests. Kept out of pages/ so Next does not build it as an API route.
//
// The gate is adminApi's (covered by its own tests): this stand-in applies the route's declared
// permission for the request method with the real checks, before the handler, as the real chain does.
// Usage: vi.mock('@server/middlewares/adminApi', async () => (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock())
type Handler = (req: unknown, res: unknown) => unknown;
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;

export const adminApiMock = async () => {
  const { ForbiddenError, MethodNotAllowedError, meetsAdminPermissionRequirement, missingAdminPermissionMessage } =
    await import('@bike4mind/common');
  type Requirement = Parameters<typeof meetsAdminPermissionRequirement>[1];
  type Req = { method?: string; user?: Parameters<typeof meetsAdminPermissionRequirement>[0] };

  const requireAdminPermission = (req: Req, requirement: Requirement) => {
    if (!meetsAdminPermissionRequirement(req.user, requirement)) {
      throw new ForbiddenError(missingAdminPermissionMessage(requirement));
    }
  };

  return {
    requireAdminPermission,
    adminApi: (config: { adminPermissions: Partial<Record<string, Requirement>> }) => {
      const handlers: Record<string, Handler> = {};
      const middlewares: Middleware[] = [];
      const register =
        (method: string) =>
        (...fns: Handler[]) => {
          handlers[method] = fns[fns.length - 1];
          return chain;
        };
      const chain = Object.assign(
        async (req: Req, res: unknown) => {
          const method = req.method ?? 'GET';
          const requirement = config.adminPermissions[method];
          if (!requirement) throw new MethodNotAllowedError('Admin route has no permission declared for this method');
          requireAdminPermission(req, requirement);
          for (const middleware of middlewares) await middleware(req, res, () => undefined);
          return handlers[method]?.(req, res);
        },
        {
          use: (middleware: Middleware) => {
            // A mocked factory such as csrfProtection() may yield undefined; the real chain would not.
            if (typeof middleware === 'function') middlewares.push(middleware);
            return chain;
          },
          get: register('GET'),
          post: register('POST'),
          put: register('PUT'),
          patch: register('PATCH'),
          delete: register('DELETE'),
          _config: config,
          _middlewares: middlewares,
        }
      );
      return chain;
    },
  };
};
