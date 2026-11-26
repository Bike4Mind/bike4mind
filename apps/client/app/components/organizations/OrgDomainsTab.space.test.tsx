import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrgDomainsTab from './OrgDomainsTab';

const api = vi.hoisted(() => ({ fetchClaims: vi.fn(), update: vi.fn() }));
vi.mock('@client/app/utils/spaceDomainAPICalls', () => ({
  fetchSpaceDomainClaims: api.fetchClaims,
  addSpaceDomainClaim: vi.fn(),
  verifySpaceDomainClaim: vi.fn(),
  updateSpaceDomainClaimPolicy: api.update,
  deleteSpaceDomainClaim: vi.fn(),
}));
vi.mock('@client/app/utils/orgDomainAPICalls', () => ({
  fetchOrgDomainClaims: vi.fn(),
  addOrgDomainClaim: vi.fn(),
  verifyOrgDomainClaim: vi.fn(),
  updateOrgDomainClaimPolicy: vi.fn(),
  deleteOrgDomainClaim: vi.fn(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const VERIFIED = {
  id: 'c2',
  domain: 'b.com',
  status: 'verified',
  verifiedAt: null,
  policy: 'off',
  createdAt: '2026-01-01T00:00:00Z',
  recordName: null,
  recordValue: null,
};

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <OrgDomainsTab owner={{ kind: 'space', id: 'sp1' }} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchClaims.mockResolvedValue([VERIFIED]);
});

describe('OrgDomainsTab as a Space domain tab', () => {
  it('loads the Space claims and uses space-prefixed test ids', async () => {
    renderTab();
    expect(await screen.findByTestId('space-domains-row')).toHaveTextContent('b.com');
    expect(api.fetchClaims).toHaveBeenCalledWith('sp1');
    expect(screen.queryByTestId('org-domains-row')).not.toBeInTheDocument();
  });

  it('never offers auto-join, only off and suggest', async () => {
    renderTab();
    const row = await screen.findByTestId('space-domains-row');
    fireEvent.click(within(within(row).getByTestId('space-domains-policy-select')).getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    const labels = options.map(option => option.textContent?.toLowerCase() ?? '');
    expect(labels).toHaveLength(2);
    expect(labels.some(label => label.includes('auto'))).toBe(false);
  });

  it('saves a policy change through the Space call', async () => {
    api.update.mockResolvedValue({ ...VERIFIED, policy: 'suggest' });
    renderTab();
    const row = await screen.findByTestId('space-domains-row');
    fireEvent.click(within(within(row).getByTestId('space-domains-policy-select')).getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[1]);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sp1', 'c2', { policy: 'suggest' }));
  });
});
