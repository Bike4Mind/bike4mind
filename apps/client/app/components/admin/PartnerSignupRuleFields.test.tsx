import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const api = vi.hoisted(() => ({ searchOrganizations: vi.fn(), fetchOrganizationById: vi.fn() }));
vi.mock('@client/app/utils/partnerSignupRuleAPICalls', () => api);

import {
  PartnerRuleDomainField,
  PartnerRuleEnabledField,
  PartnerRuleOrganizationField,
  type PartnerRuleOrganizationValue,
} from './PartnerSignupRuleFields';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>
    </QueryClientProvider>
  );

const ACME = { id: 'org1', name: 'Acme' };

function OrgHarness({ seed, initial }: { seed: string | null; initial: PartnerRuleOrganizationValue }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PartnerRuleOrganizationField
        value={value.organization}
        onChange={update => setValue(current => ({ ...current, ...update(current) }))}
        seedOrganizationId={seed}
      />
      <span data-testid="org-state">{JSON.stringify(value)}</span>
      <button data-testid="org-pick-other" onClick={() => setValue({ organizationId: 'org2', organization: null })} />
    </>
  );
}

const orgState = () => JSON.parse(screen.getByTestId('org-state').textContent ?? '{}');

describe('PartnerRuleDomainField', () => {
  it('edits a new domain and locks a saved one', () => {
    const onChange = vi.fn();
    const { unmount } = wrap(<PartnerRuleDomainField value="" onChange={onChange} locked={false} />);
    const input = screen.getByTestId('partner-rule-domain-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'partner.com' } });
    expect(onChange).toHaveBeenCalledWith('partner.com');
    expect(screen.getByText(/Bare domain only/)).toBeInTheDocument();
    unmount();

    wrap(<PartnerRuleDomainField value="partner.com" onChange={onChange} locked />);
    expect(screen.getByTestId('partner-rule-domain-input').querySelector('input')).toBeDisabled();
    expect(screen.getByText(/cannot be changed/)).toBeInTheDocument();
  });
});

describe('PartnerRuleEnabledField', () => {
  it.each([true, false])('reports the toggled value (starting enabled: %s)', value => {
    const onChange = vi.fn();
    wrap(<PartnerRuleEnabledField value={value} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('partner-rule-enabled-switch').querySelector('input')!);
    expect(onChange).toHaveBeenCalledWith(!value);
  });
});

describe('PartnerRuleOrganizationField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.searchOrganizations.mockResolvedValue([ACME]);
  });

  it('searches by name and stores the picked org id, then clears it', async () => {
    wrap(<OrgHarness seed={null} initial={{ organizationId: null, organization: null }} />);
    const input = screen.getByTestId('partner-rule-org-input').querySelector('input')!;
    await userEvent.type(input, 'Ac');
    await waitFor(() => expect(api.searchOrganizations).toHaveBeenCalledWith('Ac'));
    await userEvent.click(await screen.findByRole('option', { name: 'Acme' }));
    expect(orgState()).toEqual({ organizationId: 'org1', organization: ACME });

    await userEvent.click(screen.getByTitle('Clear'));
    expect(orgState()).toEqual({ organizationId: null, organization: null });
    expect(api.fetchOrganizationById).not.toHaveBeenCalled();
  });

  it('seeds the picker label for a saved org id', async () => {
    api.fetchOrganizationById.mockResolvedValue(ACME);
    wrap(<OrgHarness seed="org1" initial={{ organizationId: 'org1', organization: null }} />);
    await waitFor(() => expect(orgState()).toEqual({ organizationId: 'org1', organization: ACME }));
    expect(api.fetchOrganizationById).toHaveBeenCalledWith('org1');
  });

  it('keeps an org picked while the seed was loading', async () => {
    const seed = Promise.withResolvers<typeof ACME>();
    api.fetchOrganizationById.mockReturnValue(seed.promise);
    wrap(<OrgHarness seed="org1" initial={{ organizationId: 'org1', organization: null }} />);
    fireEvent.click(screen.getByTestId('org-pick-other'));
    await act(async () => seed.resolve(ACME));
    expect(orgState()).toEqual({ organizationId: 'org2', organization: null });
  });

  it.each([
    ['a deleted org', () => api.fetchOrganizationById.mockResolvedValue(null)],
    ['a failed lookup', () => api.fetchOrganizationById.mockRejectedValue(new Error('down'))],
  ])('leaves the label empty for %s', async (_label, arrange) => {
    arrange();
    wrap(<OrgHarness seed="org1" initial={{ organizationId: 'org1', organization: null }} />);
    await waitFor(() => expect(api.fetchOrganizationById).toHaveBeenCalled());
    await act(async () => undefined);
    expect(orgState()).toEqual({ organizationId: 'org1', organization: null });
  });

  it('ignores a seed that resolves after unmount', async () => {
    const seed = Promise.withResolvers<typeof ACME>();
    api.fetchOrganizationById.mockReturnValue(seed.promise);
    const onChange = vi.fn();
    const { unmount } = wrap(
      <PartnerRuleOrganizationField value={null} onChange={onChange} seedOrganizationId="org1" />
    );
    unmount();
    await act(async () => seed.resolve(ACME));
    expect(onChange).not.toHaveBeenCalled();
  });
});
