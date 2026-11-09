import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Inline PR digest settings.
 *
 * Pins the behaviors the tab depends on: each field stages its edit for the page's one SaveBar and
 * saves its own key, a blank identity map is a legitimate save (not a rejected empty), the webhook
 * URL is a sensitive field (never re-submits its stored mask, clears with confirmClear), and the
 * egress allowlist is edited as hosts with an explicit "empty blocks every send" warning.
 */

const { store, updateMutateAsync } = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  updateMutateAsync: vi.fn(),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => store[key],
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: updateMutateAsync, isPending: false }),
}));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'pr-report' } } },
    navigate: vi.fn(),
  }),
}));

import { SettingsDraftProvider } from '../SettingsDraftProvider';
import { PrReportSettings } from './PrReportSettings';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const renderSettings = () =>
  render(
    <SettingsDraftProvider>
      <PrReportSettings />
    </SettingsDraftProvider>,
    { wrapper }
  );

const saveBar = () => screen.queryByTestId('admin-save-bar');
const savePage = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('admin-save-confirm-btn'));
  await waitFor(() => expect(saveBar()).toBeNull());
};

beforeEach(() => {
  updateMutateAsync.mockReset();
  updateMutateAsync.mockResolvedValue({});
  store.prReportRepo = 'acme/widgets';
  store.prReportWebhookUrl = '';
  store.prReportIdentityMap = 'octocat U01ABCD2EF';
  store.prReportEgressAllowlist = { hosts: ['hooks.slack.com'] };
});

describe('PrReportSettings', () => {
  it('stages an edited repo for the SaveBar, then saves it under its own key', async () => {
    const user = userEvent.setup();
    renderSettings();

    // No per-field Save button, and nothing to save on mount.
    expect(screen.queryByTestId('pr-report-repo-save-btn')).toBeNull();
    expect(saveBar()).toBeNull();

    const input = screen.getByTestId('pr-report-repo-input');
    await user.clear(input);
    await user.type(input, 'other/repo');
    expect(saveBar()).toHaveTextContent('1 unsaved change');
    expect(updateMutateAsync).not.toHaveBeenCalled();

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportRepo', value: 'other/repo' });
  });

  it('allows saving a blank identity map', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.clear(screen.getByTestId('pr-report-identity-map-input'));
    expect(saveBar()).toHaveTextContent('1 unsaved change');
    expect(screen.getByTestId('admin-save-confirm-btn')).not.toBeDisabled();

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportIdentityMap', value: '' });
  });

  it('saves several edited fields from one Save, one key each', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.clear(screen.getByTestId('pr-report-repo-input'));
    await user.type(screen.getByTestId('pr-report-repo-input'), 'other/repo');
    await user.clear(screen.getByTestId('pr-report-identity-map-input'));
    expect(saveBar()).toHaveTextContent('2 unsaved changes');

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledTimes(2);
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportRepo', value: 'other/repo' });
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportIdentityMap', value: '' });
  });

  it('discards staged edits back to the stored values without writing', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.clear(screen.getByTestId('pr-report-repo-input'));
    await user.type(screen.getByTestId('pr-report-repo-input'), 'other/repo');
    await user.click(screen.getByTestId('admin-save-discard-btn'));

    expect(screen.getByTestId('pr-report-repo-input')).toHaveValue('acme/widgets');
    expect(saveBar()).toBeNull();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it('saves a newly entered webhook URL under its own key, and ignores whitespace alone', async () => {
    const user = userEvent.setup();
    renderSettings();

    const input = screen.getByTestId('pr-report-webhook-input');
    await user.type(input, '   ');
    expect(saveBar()).toBeNull();

    const webhook = 'https://hooks.slack.com/services/T00000000/B00000000/example-webhook-token';
    await user.clear(input);
    await user.type(input, webhook);
    expect(saveBar()).toHaveTextContent('1 unsaved change');

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportWebhookUrl', value: webhook });
  });

  it('stages clearing a stored webhook URL and saves it with an explicit confirmClear', async () => {
    // A stored secret comes back masked; the field never renders it and only offers Clear.
    store.prReportWebhookUrl = '********';
    const user = userEvent.setup();
    renderSettings();

    // The mask must never round-trip into the input - only a fresh entry can be submitted.
    const input = screen.getByTestId('pr-report-webhook-input');
    expect(input).not.toHaveValue('********');
    expect(input).toHaveValue('');

    await user.click(screen.getByTestId('pr-report-webhook-clear-btn'));
    expect(updateMutateAsync).not.toHaveBeenCalled();
    expect(saveBar()).toHaveTextContent('1 unsaved change');
    expect(input).toHaveAttribute('placeholder', 'The saved URL is removed when you save.');
    expect(screen.queryByTestId('pr-report-webhook-clear-btn')).toBeNull();

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledWith({ key: 'prReportWebhookUrl', value: '', confirmClear: true });
  });

  it('edits the egress allowlist as hosts and saves an object value', async () => {
    const user = userEvent.setup();
    renderSettings();

    // Scope to the chip container: "hooks.slack.com" also appears in the helper copy.
    const hosts = () => within(screen.getByTestId('pr-report-egress-hosts'));
    expect(hosts().getByText('hooks.slack.com')).toBeInTheDocument();

    // A pasted URL is reduced to its hostname before it becomes a chip.
    await user.type(screen.getByTestId('pr-report-egress-add-input'), 'https://slack-proxy.internal.test/services/x');
    await user.click(screen.getByTestId('pr-report-egress-add-btn'));
    expect(hosts().getByText('slack-proxy.internal.test')).toBeInTheDocument();
    expect(saveBar()).toHaveTextContent('1 unsaved change');

    await savePage(user);
    expect(updateMutateAsync).toHaveBeenCalledWith({
      key: 'prReportEgressAllowlist',
      value: { hosts: ['hooks.slack.com', 'slack-proxy.internal.test'] },
    });
  });

  it('warns that an empty egress allowlist blocks every send', () => {
    store.prReportEgressAllowlist = { hosts: [] };
    renderSettings();

    const empty = screen.getByTestId('pr-report-egress-empty');
    expect(empty).toHaveTextContent(/every send is blocked/i);
    expect(empty).toHaveAttribute('data-tone', 'bad');
  });

  it('marks required fields on the label and says optional in the help, with no status chips', () => {
    renderSettings();

    expect(screen.getByTestId('pr-report-repo-input')).toBeRequired();
    expect(screen.getByTestId('pr-report-webhook-input')).toBeRequired();
    expect(screen.getByTestId('pr-report-identity-map-input')).not.toBeRequired();
    expect(screen.getByTestId('pr-report-webhook-helper').textContent).toMatch(/^Required to send\./);
    expect(screen.getByTestId('pr-report-identity-map-helper').textContent).toMatch(/^Optional\./);
    for (const badge of ['Required', 'Required to send', 'Optional']) {
      expect(screen.queryByText(badge, { exact: true })).toBeNull();
    }
  });

  it('lays each field help out as one wrapping block so its code spans flow with the text', () => {
    renderSettings();

    for (const id of ['pr-report-repo', 'pr-report-identity-map', 'pr-report-egress']) {
      const helper = screen.getByTestId(`${id}-helper`);
      expect(helper).toHaveStyle({ display: 'block' });
      for (const code of helper.querySelectorAll('code')) {
        expect(code.parentElement).toBe(helper);
      }
    }
  });

  it('groups the fields into titled settings sections', () => {
    renderSettings();

    for (const [id, title] of [
      ['pr-report-section-repository', 'Source'],
      ['pr-report-section-slack', 'Slack delivery'],
    ]) {
      const section = screen.getByTestId(id);
      expect(section.tagName).toBe('SECTION');
      expect(section.closest('.MuiCard-root')).toBeNull();
      expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe(title);
    }
  });
});
