import { StrictMode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { parseAdminSearch } from './adminTabParams';
import { useAdminModal } from './useAdminModal';
import { useAdminTabUrlSync } from './useAdminTabUrlSync';

const mocks = vi.hoisted(() => ({
  rawConfig: {},
  settingsQuery: { data: [], isLoading: false, isError: false, isFetching: false, refetch: () => {} },
  update: { mutateAsync: () => Promise.resolve({}), isPending: false },
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => mocks.rawConfig,
  useSettingsFromServer: () => mocks.settingsQuery,
  useUpdateSettings: () => mocks.update,
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: () => Promise.resolve({ data: { workspaces: [] } }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SecopsTriageTab from './SecopsTriageTab';

const theme = extendTheme({ ...getThemeConfig() });

// A stand-in for AdminPage: the sidebar sets the tab in the store first, as AdminLayout does on /admin.
function Console() {
  const activeTab = useAdminModal(state => state.activeTab);
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  useAdminTabUrlSync(activeTab, setActiveTab);
  return (
    <>
      <button onClick={() => setActiveTab(AdminTab.Users)}>Users</button>
      {activeTab === AdminTab.SecOpsTriage ? <SecopsTriageTab /> : <p>Users panel</p>}
    </>
  );
}

async function renderConsole() {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: Console,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin]),
    history: createMemoryHistory({ initialEntries: ['/admin?tab=sec-ops-triage'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CssVarsProvider theme={theme}>
          <RouterProvider router={router} />
        </CssVarsProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  await screen.findByTestId('secops-triage-enabled-switch');
  return router;
}

const enabledSwitch = () => within(screen.getByTestId('secops-triage-enabled-switch')).getByRole('switch');

beforeEach(() => useAdminModal.setState(useAdminModal.getInitialState()));
afterEach(() => {
  cleanup();
  useAdminModal.setState(useAdminModal.getInitialState());
});

describe('SecopsTriageTab unsaved changes with the real router and tab store', () => {
  it('asks before a sidebar switch drops an edit; Keep editing keeps it and Discard leaves', async () => {
    const router = await renderConsole();
    fireEvent.click(enabledSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));

    expect(await screen.findByTestId('admin-unsaved-dialog')).toHaveTextContent('Discard unsaved changes?');
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.SecOpsTriage);
    expect(router.state.location.search.tab).toBe('sec-ops-triage');

    fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull());
    expect(enabledSwitch()).toBeChecked();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    fireEvent.click(await screen.findByTestId('admin-unsaved-discard-btn'));
    await screen.findByText('Users panel');
    expect(router.state.location.search.tab).toBe('users');
  });

  it('switches straight away when nothing is unsaved', async () => {
    const router = await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));

    await screen.findByText('Users panel');
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
    await waitFor(() => expect(router.state.location.search.tab).toBe('users'));
  });
});
