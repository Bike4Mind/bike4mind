import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Inline PR digest settings.
 *
 * Pins the behaviors the tab depends on: each field saves its own key, a blank identity
 * map is a legitimate save (not a rejected empty), the webhook URL is a sensitive field
 * (never re-submits its stored mask, clears with confirmClear), and the egress allowlist
 * is edited as hosts with an explicit "empty blocks every send" warning.
 */

const { store, updateMutate } = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  updateMutate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => store[key],
  useUpdateSettings: () => ({ mutate: updateMutate, isPending: false }),
}));

import { PrReportSettings } from './PrReportSettings';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

beforeEach(() => {
  updateMutate.mockReset();
  // Report every write as successful so the field can flip to its saved state.
  updateMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
  store.prReportRepo = 'acme/widgets';
  store.prReportWebhookUrl = '';
  store.prReportIdentityMap = 'octocat U01ABCD2EF';
  store.prReportEgressAllowlist = { hosts: ['hooks.slack.com'] };
});

describe('PrReportSettings', () => {
  it('saves an edited repo under its own key', async () => {
    const user = userEvent.setup();
    render(<PrReportSettings />, { wrapper });

    // Not dirty on mount.
    expect(screen.getByTestId('pr-report-repo-save-btn')).toBeDisabled();

    const input = screen.getByTestId('pr-report-repo-input');
    await user.clear(input);
    await user.type(input, 'other/repo');
    await user.click(screen.getByTestId('pr-report-repo-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith({ key: 'prReportRepo', value: 'other/repo' }, expect.any(Object));
  });

  it('allows saving a blank identity map', async () => {
    const user = userEvent.setup();
    render(<PrReportSettings />, { wrapper });

    const textarea = screen.getByTestId('pr-report-identity-map-input');
    await user.clear(textarea);
    const saveBtn = screen.getByTestId('pr-report-identity-map-save-btn');
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);

    expect(updateMutate).toHaveBeenCalledWith({ key: 'prReportIdentityMap', value: '' }, expect.any(Object));
  });

  it('saves a newly entered webhook URL under its own key', async () => {
    const user = userEvent.setup();
    render(<PrReportSettings />, { wrapper });

    const webhook = 'https://hooks.slack.com/services/T00000000/B00000000/example-webhook-token';
    const input = screen.getByTestId('pr-report-webhook-input');
    await user.type(input, webhook);
    await user.click(screen.getByTestId('pr-report-webhook-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith({ key: 'prReportWebhookUrl', value: webhook }, expect.any(Object));
  });

  it('clears a stored webhook URL with an explicit confirmClear', async () => {
    // A stored secret comes back masked; the field never renders it and only offers Clear.
    store.prReportWebhookUrl = '********';
    const user = userEvent.setup();
    render(<PrReportSettings />, { wrapper });

    // The mask must never round-trip into the input - only a fresh entry can be submitted.
    expect(screen.getByTestId('pr-report-webhook-input')).not.toHaveValue('********');
    expect(screen.getByTestId('pr-report-webhook-input')).toHaveValue('');

    await user.click(screen.getByTestId('pr-report-webhook-clear-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { key: 'prReportWebhookUrl', value: '', confirmClear: true },
      expect.any(Object)
    );
    expect(screen.getByText('Cleared')).toBeInTheDocument();
  });

  it('edits the egress allowlist as hosts and saves an object value', async () => {
    const user = userEvent.setup();
    render(<PrReportSettings />, { wrapper });

    // Scope to the chip container: "hooks.slack.com" also appears in the helper copy.
    const hosts = () => within(screen.getByTestId('pr-report-egress-hosts'));
    expect(hosts().getByText('hooks.slack.com')).toBeInTheDocument();

    // A pasted URL is reduced to its hostname before it becomes a chip.
    await user.type(screen.getByTestId('pr-report-egress-add-input'), 'https://slack-proxy.internal.test/services/x');
    await user.click(screen.getByTestId('pr-report-egress-add-btn'));
    expect(hosts().getByText('slack-proxy.internal.test')).toBeInTheDocument();

    await user.click(screen.getByTestId('pr-report-egress-save-btn'));
    expect(updateMutate).toHaveBeenCalledWith(
      { key: 'prReportEgressAllowlist', value: { hosts: ['hooks.slack.com', 'slack-proxy.internal.test'] } },
      expect.any(Object)
    );
  });

  it('warns that an empty egress allowlist blocks every send', () => {
    store.prReportEgressAllowlist = { hosts: [] };
    render(<PrReportSettings />, { wrapper });

    expect(screen.getByText(/every send is blocked/i)).toBeInTheDocument();
  });
});
