import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationApiKeysCard from './OrganizationApiKeysCard';

const mocks = vi.hoisted(() => ({ account: vi.fn() }));

vi.mock('@client/app/hooks/data/organizations', () => ({ useAdminOrgServiceAccountId: mocks.account }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    search: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={`${to.replace('$userId', params.userId)}?tab=${search.tab}`} {...rest}>
      {children}
    </a>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderCard = () => render(<OrganizationApiKeysCard orgId="org-1" />, { wrapper: Wrapper });

describe('OrganizationApiKeysCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links to the service account profile Keys tab', () => {
    mocks.account.mockReturnValue({ data: 'svc-1', isPending: false, isError: false });
    renderCard();
    expect(mocks.account).toHaveBeenCalledWith('org-1');
    expect(screen.getByTestId('org-api-keys-link')).toHaveAttribute('href', '/admin/users/svc-1?tab=keys');
  });

  it('says so when the organization has no service account yet', () => {
    mocks.account.mockReturnValue({ data: null, isPending: false, isError: false });
    renderCard();
    expect(screen.queryByTestId('org-api-keys-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-api-keys-card')).toHaveTextContent('No API keys have been created');
  });

  it('reports a failed lookup', () => {
    mocks.account.mockReturnValue({ data: undefined, isPending: false, isError: true });
    renderCard();
    expect(screen.getByTestId('org-api-keys-card')).toHaveTextContent('API keys could not be loaded.');
  });
});
