import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrgDomainsTab from './OrgDomainsTab';

const api = vi.hoisted(() => ({
  fetchClaims: vi.fn(),
  add: vi.fn(),
  verify: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@client/app/utils/orgDomainAPICalls', () => ({
  fetchOrgDomainClaims: api.fetchClaims,
  addOrgDomainClaim: api.add,
  verifyOrgDomainClaim: api.verify,
  updateOrgDomainClaimPolicy: api.update,
  deleteOrgDomainClaim: api.remove,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const PENDING = {
  id: 'c1',
  domain: 'acme.com',
  status: 'pending',
  verifiedAt: null,
  policy: 'off',
  defaultRole: 'member',
  createdAt: '2026-01-01T00:00:00Z',
  recordName: '_b4m-verify.acme.com',
  recordValue: 'b4m-domain-verification=abc',
};
const VERIFIED = { ...PENDING, id: 'c2', domain: 'b.com', status: 'verified', recordName: null, recordValue: null };

const axiosError = (status: number, message: string) => {
  const headers = new AxiosHeaders();
  return new AxiosError(message, String(status), { headers }, null, {
    status,
    statusText: '',
    headers,
    config: { headers },
    data: { message },
  });
};

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <OrgDomainsTab organizationId="org1" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const rowFor = async (domain: string) =>
  (await screen.findAllByTestId('org-domains-row')).find(row => row.textContent?.includes(domain))!;

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchClaims.mockResolvedValue([PENDING]);
});

describe('OrgDomainsTab', () => {
  it('shows the TXT record to publish for a pending claim, with join controls locked', async () => {
    renderTab();
    expect(await screen.findByTestId('org-domains-txt-name')).toHaveValue('_b4m-verify.acme.com');
    expect(screen.getByTestId('org-domains-txt-value')).toHaveValue('b4m-domain-verification=abc');
    expect(screen.getByTestId('org-domains-status')).toHaveTextContent('Pending verification');
    expect(within(screen.getByTestId('org-domains-policy-select')).getByRole('combobox')).toBeDisabled();
  });

  it('shows why a verify attempt failed', async () => {
    api.verify.mockResolvedValue({ verified: false, reason: 'No TXT record found yet' });
    renderTab();
    fireEvent.click(await screen.findByTestId('org-domains-verify-btn'));
    expect(await screen.findByTestId('org-domains-verify-reason')).toHaveTextContent('No TXT record found yet');
    expect(api.verify).toHaveBeenCalledWith('org1', 'c1');
  });

  it('refetches after a successful verify', async () => {
    api.verify.mockResolvedValue({ verified: true, claim: { ...PENDING, status: 'verified' } });
    renderTab();
    fireEvent.click(await screen.findByTestId('org-domains-verify-btn'));
    await waitFor(() => expect(api.fetchClaims).toHaveBeenCalledTimes(2));
  });

  it('offers policy and role controls on a verified claim and saves a change through PATCH', async () => {
    api.fetchClaims.mockResolvedValue([VERIFIED]);
    api.update.mockResolvedValue({ ...VERIFIED, policy: 'auto-join' });
    renderTab();
    const row = await rowFor('b.com');
    expect(within(row).queryByTestId('org-domains-txt-name')).not.toBeInTheDocument();

    fireEvent.click(within(within(row).getByTestId('org-domains-policy-select')).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Join automatically' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('org1', 'c2', { policy: 'auto-join' }));

    fireEvent.click(within(within(row).getByTestId('org-domains-role-select')).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Viewer (read only)' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('org1', 'c2', { defaultRole: 'viewer' }));
  });

  it('adds a domain and surfaces the server error for one already claimed elsewhere', async () => {
    api.add.mockRejectedValueOnce(axiosError(409, 'Domain already claimed by another organization'));
    renderTab();
    fireEvent.change(await screen.findByTestId('org-domains-add-input'), { target: { value: 'taken.com' } });
    fireEvent.click(screen.getByTestId('org-domains-add-btn'));

    expect(await screen.findByTestId('org-domains-add-error')).toHaveTextContent(
      'Domain already claimed by another organization'
    );
    expect(api.add).toHaveBeenCalledWith('org1', 'taken.com');
  });

  it('removes a claim only after confirming', async () => {
    api.remove.mockResolvedValue(undefined);
    renderTab();
    fireEvent.click(await screen.findByTestId('org-domains-delete-btn'));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('org-domains-delete-confirm-btn'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('org1', 'c1'));
  });

  it('says so when there are no domains', async () => {
    api.fetchClaims.mockResolvedValue([]);
    renderTab();
    expect(await screen.findByTestId('org-domains-empty')).toBeInTheDocument();
  });
});
