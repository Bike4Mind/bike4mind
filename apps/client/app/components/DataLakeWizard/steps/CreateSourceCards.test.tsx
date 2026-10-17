import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub',
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: { currentUser: null }) => unknown) => select({ currentUser: null }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (select: (s: { selectedAccount: null }) => unknown) => select({ selectedAccount: null }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ data: undefined }),
}));

import CreateSourceCards from './CreateSourceCards';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('CreateSourceCards', () => {
  it('tells a user in personal scope to switch accounts when GitHub is disabled', () => {
    wrap(<CreateSourceCards />);

    expect(screen.getByTestId('create-source-card-github')).toBeDisabled();
    expect(screen.getByTestId('create-source-reason-github')).toHaveTextContent(/switch to your team account/i);
    expect(screen.getByTestId('create-source-reason-github')).toHaveTextContent(
      /account switcher in the profile menu/i
    );
  });
});
