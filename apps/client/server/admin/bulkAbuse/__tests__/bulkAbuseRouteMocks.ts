// Shared vi.mock factories for pages/api/admin/abuse/__tests__. Kept out of pages/ so Next does not
// build it as an API route.

type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;

// Runs `.use()` middleware before the handler so adminApi's permission gate is exercised.
export const baseApiMock = () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Middleware[] = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) {
          await new Promise<void>((resolve, reject) => {
            Promise.resolve(middleware(req, res, resolve)).catch(reject);
          });
        }
        return h[(req as { method?: string }).method ?? 'POST']?.(req, res);
      },
      {
        use: (middleware: Middleware) => (middlewares.push(middleware), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
});

export const asyncHandlerMock = () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
});

export const databaseMock = () => ({
  authSessionRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  realtimeConnectionRepository: {},
  trustedDeviceRepository: {},
  userRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
});

export const ADMIN = { id: 'a'.repeat(24), isAdmin: true, username: 'admin', email: 'admin@example.com' };
/** A delegated operator who may bulk-moderate but not edit admin settings (so cannot ban a domain). */
export const MODERATOR = { ...ADMIN, isAdmin: false, adminPermissions: ['users:moderate'] };
export const USER_ID = 'b'.repeat(24);
export const OTHER_ID = 'c'.repeat(24);
export const ALL_ACTIONS = { ban: true, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: true };

export const makeUser = (id: string) => ({ id, email: `${id}@np.kashre.com`, username: id, isBanned: false });
