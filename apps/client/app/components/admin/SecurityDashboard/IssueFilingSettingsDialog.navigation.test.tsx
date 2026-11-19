import { useState } from 'react';
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecopsTriageConfigSchema } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { ADMIN_SETTINGS_ARRAY_QUERY_KEY } from '@client/app/hooks/data/queryKeys';
import { parseAdminSearch } from '../adminTabParams';
import { useAdminModal } from '../useAdminModal';
import { useSecurityDashboardSearch } from './useSecurityDashboardSearch';
import { IssueFilingSettingsDialog } from './IssueFilingSettingsDialog';

const transport = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), settingsGet: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: transport.get, put: transport.put } }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const theme = extendTheme({ ...getThemeConfig() });
const TEST_ID = 'security-issue-filing-settings';
const SCANS_URL = '/admin?tab=security-dashboard&securityView=scans';
const originalTokenState = useAccessToken.getState();
const clients: QueryClient[] = [];
const histories: ReturnType<typeof createMemoryHistory>[] = [];
const originalHref = window.location.href;
const originalHistoryState: unknown = window.history.state;
const settings = (dryRun = false) => [
  { settingName: 'secopsTriageConfig', settingValue: SecopsTriageConfigSchema.parse({ dryRun }) },
];

function Editor() {
  const [open, setOpen] = useState(true);
  return open ? <IssueFilingSettingsDialog onClose={() => setOpen(false)} /> : <p>Editor closed</p>;
}

// This uses the production parser and the same view-owned mount boundary as SecurityDashboard.
function Console() {
  const search = useSearch({ strict: false });
  const { view } = useSecurityDashboardSearch();
  return search.tab === 'security-dashboard' && view === 'scans' ? (
    <Editor />
  ) : (
    <p data-testid="destination-view">{search.tab === 'security-dashboard' ? view : 'another admin tab'}</p>
  );
}

async function renderEditor(browserHistory = false) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: Console,
  });
  const away = createRoute({
    getParentRoute: () => root,
    path: '/away',
    component: () => <p data-testid="destination-view">another page</p>,
  });
  const history = browserHistory
    ? (() => {
        window.history.replaceState(null, '', '/admin?tab=security-dashboard');
        const browser = createBrowserHistory();
        browser.push(SCANS_URL);
        return browser;
      })()
    : createMemoryHistory({
        initialEntries: ['/admin?tab=security-dashboard', SCANS_URL],
        initialIndex: 1,
      });
  histories.push(history);
  const router = createRouter({ routeTree: root.addChildren([admin, away]), history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(queryClient);
  queryClient.setQueryData(ADMIN_SETTINGS_ARRAY_QUERY_KEY, settings());
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  await screen.findByTestId(`${TEST_ID}-dry-run-switch`);
  return { router, history, queryClient };
}

const dryRunSwitch = () =>
  within(screen.getByTestId(`${TEST_ID}-dry-run-switch`)).getByRole('switch', { hidden: true });
const edit = () => fireEvent.click(dryRunSwitch());
const keepEditing = async () => {
  fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
  await waitFor(() => expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull());
};

beforeEach(() => {
  useAdminModal.setState(useAdminModal.getInitialState());
  useAccessToken.setState({ accessToken: 'fixture-access-token' });
  transport.get.mockReset();
  transport.put.mockReset();
  transport.settingsGet.mockReset();
  transport.settingsGet.mockResolvedValue({ data: settings(true) });
  transport.get.mockImplementation(async (url: string) => {
    if (url === '/api/settings/fetch') return transport.settingsGet();
    if (url === '/api/admin/slack-workspaces') return { data: { workspaces: [] } };
    throw new Error(`Unexpected fixture GET: ${url}`);
  });
  transport.put.mockResolvedValue({ data: {} });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  for (const history of histories.splice(0)) history.destroy();
  window.history.replaceState(originalHistoryState, '', originalHref);
  useAdminModal.setState(useAdminModal.getInitialState());
  useAccessToken.setState(originalTokenState, true);
});

describe('issue filing editor navigation with the real router and settings mutation', () => {
  it.each([
    '/admin?tab=security-dashboard&securityView=incident',
    '/admin?tab=security-dashboard&securityView=firewall',
    '/admin?tab=security-dashboard',
    '/admin?tab=security-dashboard&securityView=invalid',
    '/admin?tab=users',
    '/away',
  ])('retains edits until leaving %s is explicitly confirmed', async href => {
    const { router } = await renderEditor();
    edit();
    act(() => {
      void router.navigate({ href });
    });
    await screen.findByTestId('admin-unsaved-dialog');
    expect(router.state.location.search.securityView).toBe('scans');
    expect(dryRunSwitch()).toBeChecked();
    await keepEditing();
    expect(dryRunSwitch()).toBeChecked();
    act(() => {
      void router.navigate({ href });
    });
    await screen.findByTestId('admin-unsaved-dialog');
    fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
    await screen.findByTestId('destination-view');
    expect(screen.queryByTestId(TEST_ID)).toBeNull();
    expect(transport.put).not.toHaveBeenCalled();
  });

  it('blocks browser-history back in jsdom until discard is confirmed', async () => {
    const { router, history } = await renderEditor(true);
    edit();
    act(() => history.back());
    await screen.findByTestId('admin-unsaved-dialog');
    expect(router.state.location.search.securityView).toBe('scans');
    await keepEditing();
    expect(dryRunSwitch()).toBeChecked();
    act(() => history.back());
    await screen.findByTestId('admin-unsaved-dialog');
    fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
    await screen.findByTestId('destination-view');
    expect(screen.getByTestId('destination-view')).toHaveTextContent('incident');
  });

  it('keeps edits through scan and range changes within Scans', async () => {
    const { router } = await renderEditor();
    edit();
    await act(async () => {
      await router.navigate({ href: SCANS_URL + '&securityScan=cloud&securityRange=7d' });
    });
    expect(router.state.location.search).toMatchObject({
      securityView: 'scans',
      securityScan: 'cloud',
      securityRange: '7d',
    });
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
    expect(dryRunSwitch()).toBeChecked();
  });

  it('allows clean navigation without a prompt', async () => {
    const { router } = await renderEditor();
    await act(async () => {
      await router.navigate({ href: '/admin?tab=security-dashboard' });
    });
    await screen.findByTestId('destination-view');
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
  });

  it('protects a pending PUT and its deferred settings refresh without allowing discard', async () => {
    const write = Promise.withResolvers<{ data: object }>();
    const refresh = Promise.withResolvers<{ data: ReturnType<typeof settings> }>();
    transport.put.mockReturnValue(write.promise);
    transport.settingsGet.mockReturnValue(refresh.promise);
    const { router, queryClient } = await renderEditor();
    edit();
    fireEvent.click(screen.getByTestId(`${TEST_ID}-save-btn`));
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    expect(transport.put).toHaveBeenCalledWith('/api/settings/update', {
      key: 'secopsTriageConfig',
      value: SecopsTriageConfigSchema.parse({ dryRun: true }),
    });
    const attemptLeave = async () => {
      act(() => {
        void router.navigate({ href: '/admin?tab=security-dashboard&securityView=firewall' });
      });
      await screen.findByTestId('admin-unsaved-dialog');
      expect(screen.getByTestId('admin-unsaved-discard-btn')).toBeDisabled();
      fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
      expect(router.state.location.search.securityView).toBe('scans');
      expect(screen.getByTestId(`${TEST_ID}-cancel-btn`)).toBeDisabled();
      await keepEditing();
    };
    await attemptLeave();
    await act(async () => {
      write.resolve({ data: {} });
      await write.promise;
    });
    await waitFor(() => expect(transport.settingsGet).toHaveBeenCalledOnce());
    // A cache update can clear the dirty comparison before invalidation's transport settles.
    await act(async () => {
      queryClient.setQueryData(ADMIN_SETTINGS_ARRAY_QUERY_KEY, settings(true));
    });
    await waitFor(() => expect(screen.getByTestId(`${TEST_ID}-changes`)).toHaveTextContent('No unsaved changes'));
    await attemptLeave();
    await act(async () => {
      refresh.resolve({ data: settings(true) });
      await refresh.promise;
    });
    await screen.findByText('Editor closed');
    expect(transport.put).toHaveBeenCalledOnce();
    await act(async () => {
      await router.navigate({ href: '/admin?tab=security-dashboard&securityView=firewall' });
    });
    await screen.findByTestId('destination-view');
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
  });

  it('retains the draft and navigation protection after a failed PUT', async () => {
    const write = Promise.withResolvers<never>();
    transport.put.mockReturnValue(write.promise);
    const { router } = await renderEditor();
    edit();
    fireEvent.click(screen.getByTestId(`${TEST_ID}-save-btn`));
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    await act(async () => {
      write.reject(new Error('fixture write failed'));
    });
    await waitFor(() => expect(screen.getByTestId(`${TEST_ID}-save-btn`)).not.toBeDisabled());
    expect(dryRunSwitch()).toBeChecked();
    act(() => {
      void router.navigate({ href: '/admin?tab=security-dashboard&securityView=incident' });
    });
    await screen.findByTestId('admin-unsaved-dialog');
    expect(screen.getByTestId('admin-unsaved-discard-btn')).not.toBeDisabled();
  });
});
