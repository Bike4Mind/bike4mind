import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { userQueryKey } from '@client/app/hooks/data/user';
import { UndoToastProvider } from '../../shared';
import type { AdminUserProfile } from './userProfileModel';

const appTheme = extendTheme({ ...getThemeConfig() });

/** Theme, a fresh QueryClient and the UndoToast provider every profile dialog and view needs. */
export const ProfileTestWrapper = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <UndoToastProvider>{children}</UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

/** A typed fixture: only the fields a test names are set, the rest of the projection stays absent. */
export const buildProfile = (overrides: Partial<AdminUserProfile> = {}): AdminUserProfile => {
  const base: Partial<AdminUserProfile> = {
    id: 'test-user-1',
    name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.com',
    level: 'PaidUser',
    isAdmin: false,
    isBanned: false,
    isModerated: false,
    emailVerified: true,
    apiKeyTrustApproved: false,
    newAccountSpendCapLifted: false,
    currentCredits: 500,
    tags: [],
    organizationId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-10-20T00:00:00Z'),
  };
  return { ...base, ...overrides } as AdminUserProfile;
};

/**
 * Serves `buildProfile` through the `['users', id]` query, as UserProfilePage does via `useGetUser`, so a
 * dialog's refetch reaches its `user` prop. `fetchCredits` answers each fetch, the mount's first.
 */
export const LiveProfile = ({
  fetchCredits,
  children,
}: {
  fetchCredits: () => Promise<number>;
  children: (user: AdminUserProfile) => ReactNode;
}) => {
  const user = buildProfile();
  const query = useQuery({
    queryKey: userQueryKey(user.id),
    queryFn: async () => ({ ...user, currentCredits: await fetchCredits() }),
    staleTime: Infinity,
  });
  return query.data ? <>{children(query.data)}</> : null;
};
