// Shared vi.mock factories for pages/api/admin/abuse/__tests__. Kept out of pages/ so Next does not
// build it as an API route.

// The gate is adminApi's (covered by its own tests): this stand-in applies the route's declared
// permission with the real checks, before the handler, as the real chain does.
export const adminApiMock = async () => {
  const { ForbiddenError, meetsAdminPermissionRequirement, missingAdminPermissionMessage } =
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
      const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
      const chain = Object.assign(
        async (req: Req, res: unknown) => {
          const method = req.method ?? 'POST';
          const requirement = config.adminPermissions[method];
          if (requirement) requireAdminPermission(req, requirement);
          return h[method]?.(req, res);
        },
        {
          use: () => chain,
          post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
          delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
          _config: config,
        }
      );
      return chain;
    },
  };
};

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
