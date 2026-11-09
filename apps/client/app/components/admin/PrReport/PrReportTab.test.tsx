import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';

type BlockerOptions = {
  enableBeforeUnload: boolean;
  shouldBlockFn(args: {
    current: { pathname: string; search: object };
    next: { pathname: string; search: object };
  }): boolean;
};
const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  mutateAsync: vi.fn(),
  useBlocker: vi.fn<(options: BlockerOptions) => { status: string }>(() => ({ status: 'idle' })),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => mocks.store[key],
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: mocks.useBlocker,
}));
// The dialog has its own suite; here it only has to open.
vi.mock('./PrReportDialog', () => ({
  PrReportDialog: () => <div data-testid="pr-report-dialog-stub" />,
}));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { useAdminModal } from '../useAdminModal';
import { PrReportTab } from './PrReportTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PrReportTab />
    </CssVarsProvider>
  );
const lastBlocker = () => mocks.useBlocker.mock.lastCall?.[0];

beforeEach(() => {
  mocks.mutateAsync.mockReset().mockResolvedValue({});
  mocks.useBlocker.mockClear();
  mocks.store.prReportRepo = 'acme/widgets';
  mocks.store.prReportWebhookUrl = '';
  mocks.store.prReportIdentityMap = '';
  mocks.store.prReportEgressAllowlist = { hosts: ['hooks.slack.com'] };
  useAdminModal.getState().setTabChangeGuard(null);
  fakeAdminRouter.reset({ tab: 'pr-report' });
});

describe('PrReportTab', () => {
  it('opens with the page header and sits on the left gutter, capped at the settings width', () => {
    renderTab();

    const tab = screen.getByTestId('admin-pr-report-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('PR digest');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('admin-pr-report-open-btn')).toHaveTextContent('Generate digest');
    expect(tab).toHaveStyle({ maxWidth: '1280px' });
    expect(tab).not.toHaveStyle({ marginLeft: 'auto' });
    expect(tab.closest('.MuiCard-root')).toBeNull();
  });

  it('keeps Generate digest disabled until a repository is saved, then opens the dialog', async () => {
    mocks.store.prReportRepo = '';
    const user = userEvent.setup();
    const { unmount } = renderTab();
    expect(screen.getByTestId('admin-pr-report-open-btn')).toBeDisabled();
    unmount();

    mocks.store.prReportRepo = 'acme/widgets';
    renderTab();
    await user.click(screen.getByTestId('admin-pr-report-open-btn'));
    expect(screen.getByTestId('pr-report-dialog-stub')).toBeInTheDocument();
  });

  it('saves the page through one SaveBar instead of a Save button per field', async () => {
    const user = userEvent.setup();
    renderTab();

    for (const id of ['pr-report-repo', 'pr-report-webhook', 'pr-report-identity-map', 'pr-report-egress']) {
      expect(screen.queryByTestId(`${id}-save-btn`)).toBeNull();
    }
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();

    const input = screen.getByTestId('pr-report-repo-input');
    await user.clear(input);
    await user.type(input, 'other/repo');
    expect(screen.getAllByTestId('admin-save-bar')).toHaveLength(1);
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.mutateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'prReportRepo', value: 'other/repo' });
  });

  it('discards a staged edit without saving', async () => {
    const user = userEvent.setup();
    renderTab();

    const input = screen.getByTestId('pr-report-repo-input');
    await user.clear(input);
    await user.type(input, 'other/repo');
    await user.click(screen.getByTestId('admin-save-discard-btn'));

    expect(input).toHaveValue('acme/widgets');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('guards leaving the page while an edit is unsaved', async () => {
    const user = userEvent.setup();
    renderTab();
    const here = { pathname: '/admin', search: { tab: 'pr-report' } };
    const otherTab = { pathname: '/admin', search: { tab: 'admin-settings' } };

    expect(lastBlocker()?.enableBeforeUnload).toBe(false);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(false);
    expect(useAdminModal.getState().tabChangeGuard).toBeNull();

    await user.type(screen.getByTestId('pr-report-repo-input'), '-next');

    expect(lastBlocker()?.enableBeforeUnload).toBe(true);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(true);
    expect(useAdminModal.getState().tabChangeGuard).not.toBeNull();
  });
});
