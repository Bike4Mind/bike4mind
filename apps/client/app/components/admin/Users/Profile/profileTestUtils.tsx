import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
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
    currentCredits: 500,
    tags: [],
    organizationId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-10-20T00:00:00Z'),
  };
  return { ...base, ...overrides } as AdminUserProfile;
};
