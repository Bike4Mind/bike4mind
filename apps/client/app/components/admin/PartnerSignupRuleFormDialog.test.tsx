import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const api = vi.hoisted(() => ({
  createPartnerSignupRule: vi.fn(),
  updatePartnerSignupRule: vi.fn(),
  searchOrganizations: vi.fn(),
  fetchOrganizationById: vi.fn(),
}));
vi.mock('@client/app/utils/partnerSignupRuleAPICalls', () => api);
vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  fetchGrantPackages: vi.fn().mockResolvedValue({ data: [], meta: {}, reasonPolicy: {} }),
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import PartnerSignupRuleFormDialog from './PartnerSignupRuleFormDialog';

const appTheme = extendTheme({ ...getThemeConfig() });

// A legacy rule saved before label, entitlements, tags and credits had defaults.
const bareRule = {
  id: 'r1',
  domain: 'partner.com',
  enabled: false,
  organizationId: null,
} as unknown as IPartnerSignupRuleDocument;

const renderDialog = (editing: IPartnerSignupRuleDocument | null) => {
  const props = { onClose: vi.fn(), onSaved: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <PartnerSignupRuleFormDialog editing={editing} {...props} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return props;
};

const inputOf = (testId: string) =>
  screen.getByTestId(testId).querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement;

describe('PartnerSignupRuleFormDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.searchOrganizations.mockResolvedValue([{ id: 'org1', name: 'Acme' }]);
    api.updatePartnerSignupRule.mockResolvedValue({ ...bareRule });
  });

  it('fills defaults for a bare rule and sends every edited field', async () => {
    const props = renderDialog(bareRule);
    expect(inputOf('partner-rule-credits-input')).toHaveValue(0);

    fireEvent.change(inputOf('partner-rule-label-input'), { target: { value: ' Acme partner ' } });
    fireEvent.change(inputOf('partner-rule-notes-input'), { target: { value: 'Deal 7' } });
    fireEvent.change(inputOf('partner-rule-credits-input'), { target: { value: '250' } });
    await userEvent.type(inputOf('partner-rule-entitlements-input'), 'datalake:acme{Enter}');
    await userEvent.type(inputOf('partner-rule-org-input'), 'Ac');
    await userEvent.click(await screen.findByRole('option', { name: 'Acme' }));
    fireEvent.click(inputOf('partner-rule-enabled-switch'));
    await userEvent.click(screen.getByTestId('partner-rule-save-btn'));

    await waitFor(() => expect(api.updatePartnerSignupRule).toHaveBeenCalled());
    expect(api.updatePartnerSignupRule).toHaveBeenCalledWith('r1', {
      entitlements: ['datalake:acme'],
      tags: [],
      subscription: null,
      signupCredits: 250,
      grantPackageId: null,
      label: 'Acme partner',
      notes: 'Deal 7',
      enabled: true,
      organizationId: 'org1',
    });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Updated rule for partner.com');
  });

  it('shows a rejected save inline and keeps the dialog open', async () => {
    api.createPartnerSignupRule.mockRejectedValue(new Error('A signup rule for "taken.com" already exists'));
    const props = renderDialog(null);

    fireEvent.change(inputOf('partner-rule-domain-input'), { target: { value: 'taken.com' } });
    await userEvent.click(screen.getByTestId('partner-rule-save-btn'));

    expect(await screen.findByTestId('partner-rule-form-error')).toHaveTextContent('already exists');
    expect(api.createPartnerSignupRule.mock.calls[0][0]).toMatchObject({ domain: 'taken.com' });
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});
