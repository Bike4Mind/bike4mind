// Shared vi.mock factories for pages/api/admin/abuse/__tests__. Kept out of pages/ so Next does not
// build it as an API route.

export const baseApiMock = () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
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
export const USER_ID = 'b'.repeat(24);
export const OTHER_ID = 'c'.repeat(24);
export const ALL_ACTIONS = { ban: true, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: true };

export const makeUser = (id: string) => ({ id, email: `${id}@np.kashre.com`, username: id, isBanned: false });
