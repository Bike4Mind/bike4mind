import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub',
    isFeatureEnabled: () => false,
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
  useGetUserOrganizations: () => ({ data: [] }),
}));

import CreateSourceCards from './CreateSourceCards';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('CreateSourceCards', () => {
  it('offers the GitHub card as available in a personal scope', () => {
    wrap(<CreateSourceCards />);

    expect(screen.getByTestId('create-source-card-github')).not.toBeDisabled();
    expect(screen.queryByTestId('create-source-reason-github')).toBeNull();
  });
});
