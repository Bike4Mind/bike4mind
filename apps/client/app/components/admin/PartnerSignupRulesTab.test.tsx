import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';

const api = vi.hoisted(() => ({
  fetchPartnerSignupRules: vi.fn(),
  createPartnerSignupRule: vi.fn(),
  updatePartnerSignupRule: vi.fn(),
  deletePartnerSignupRule: vi.fn(),
  searchOrganizations: vi.fn(),
  fetchOrganizationById: vi.fn(),
  previewPartnerRuleBackfill: vi.fn(),
  runPartnerRuleBackfill: vi.fn(),
}));
vi.mock('@client/app/utils/partnerSignupRuleAPICalls', () => api);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PartnerSignupRulesTab from './PartnerSignupRulesTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const makeRule = (over: Partial<IPartnerSignupRuleDocument> = {}): IPartnerSignupRuleDocument =>
  ({
    id: 'r1',
    domain: 'partner.com',
    label: 'Partner',
    entitlements: [],
    tags: ['Partner', 'cohort-a'],
    signupCredits: 0,
    enabled: true,
    ...over,
  }) as IPartnerSignupRuleDocument;

const listOf = (rules: IPartnerSignupRuleDocument[]) => ({
  data: rules,
  meta: { total: rules.length, page: 1, limit: 20, totalPages: 1 },
});

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <PartnerSignupRulesTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('PartnerSignupRulesTab tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.searchOrganizations.mockResolvedValue([]);
    api.createPartnerSignupRule.mockResolvedValue(makeRule());
    api.updatePartnerSignupRule.mockResolvedValue(makeRule());
  });

  it('renders a rule tags in the table', async () => {
    api.fetchPartnerSignupRules.mockResolvedValue(listOf([makeRule()]));
    renderTab();

    const cell = await screen.findByTestId('partner-rule-tags-partner.com');
    expect(cell).toHaveTextContent('Partner');
    expect(cell).toHaveTextContent('cohort-a');
  });

  it('sends typed tags in the create payload', async () => {
    api.fetchPartnerSignupRules.mockResolvedValue(listOf([]));
    renderTab();

    await userEvent.click(await screen.findByTestId('partner-rule-add-btn'));
    await userEvent.type(screen.getByTestId('partner-rule-domain-input').querySelector('input')!, 'new.com');
    await userEvent.type(
      screen.getByTestId('partner-rule-tags-input').querySelector('input')!,
      'Beta{Enter}vip{Enter}'
    );
    await userEvent.click(screen.getByTestId('partner-rule-save-btn'));

    await waitFor(() => expect(api.createPartnerSignupRule).toHaveBeenCalled());
    expect(api.createPartnerSignupRule.mock.calls[0][0]).toMatchObject({ domain: 'new.com', tags: ['Beta', 'vip'] });
  });

  it('sends an empty tags array when all tags are cleared on edit', async () => {
    api.fetchPartnerSignupRules.mockResolvedValue(listOf([makeRule()]));
    renderTab();

    await userEvent.click(await screen.findByTestId('partner-rule-edit-partner.com'));
    const input = screen.getByTestId('partner-rule-tags-input').querySelector('input')!;
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}{Backspace}');
    await userEvent.click(screen.getByTestId('partner-rule-save-btn'));

    await waitFor(() => expect(api.updatePartnerSignupRule).toHaveBeenCalled());
    expect(api.updatePartnerSignupRule.mock.calls[0][0]).toBe('r1');
    expect(api.updatePartnerSignupRule.mock.calls[0][1]).toMatchObject({ tags: [] });
  });
});
