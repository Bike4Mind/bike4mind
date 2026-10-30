import { StrictMode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';
import { AdminTab } from './adminSidebarConfig';
import { parseAdminSearch } from './adminTabParams';
import { useAdminModal } from './useAdminModal';
import { useAdminTabUrlSync } from './useAdminTabUrlSync';

const theme = extendTheme({ ...getThemeConfig() });
const save = vi.fn<(value: string) => Promise<unknown>>();

function Field() {
  const draft = useSettingsDraft('example', 'stored', { save, name: 'Example' });
  return <input aria-label="Example" value={draft.value} onChange={event => draft.setValue(event.target.value)} />;
}

function Console() {
  const activeTab = useAdminModal(state => state.activeTab);
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  useAdminTabUrlSync(activeTab, setActiveTab);
  return (
    <>
      <button onClick={() => setActiveTab(AdminTab.Users)}>Users</button>
      <button onClick={() => setActiveTab(AdminTab.AdminSettings)}>Settings</button>
      {activeTab === AdminTab.AdminSettings ? (
        <SettingsDraftProvider>
          <Field />
        </SettingsDraftProvider>
      ) : (
        <p>Users panel</p>
      )}
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
    history: createMemoryHistory({ initialEntries: ['/admin?tab=admin-settings'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </StrictMode>
  );
  await screen.findByRole('textbox', { name: 'Example' });
  return router;
}

beforeEach(() => {
  useAdminModal.setState(useAdminModal.getInitialState());
  save.mockReset();
  save.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  useAdminModal.setState(useAdminModal.getInitialState());
});

describe('staged settings navigation with the real router and tab store', () => {
  it('keeps the draft and URL until a store-driven switch is explicitly confirmed', async () => {
    const router = await renderConsole();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Users', exact: true }));
    await screen.findByTestId('admin-unsaved-dialog');
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.AdminSettings);
    expect(router.state.location.search.tab).toBe('admin-settings');
    fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull());
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Users', exact: true }));
    await screen.findByTestId('admin-unsaved-dialog');
    fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
    await screen.findByText('Users panel');
    expect(router.state.location.search.tab).toBe('users');
    expect(useAdminModal.getState().tabChangeGuard).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings', exact: true }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('stored'));
  });

  it('allows settings filter changes and guards URL-first tab changes', async () => {
    const router = await renderConsole();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    await act(async () => {
      await router.navigate({ to: '/admin', search: { tab: 'admin-settings', q: 'hidden' } });
    });
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    act(() => {
      void router.navigate({ to: '/admin', search: { tab: 'users' } });
    });
    await screen.findByTestId('admin-unsaved-dialog');
    fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
    await screen.findByText('Users panel');
    expect(router.state.location.search.tab).toBe('users');
  });

  it('prevents discarding an in-flight save, then allows switching after success', async () => {
    const router = await renderConsole();
    const result = Promise.withResolvers<unknown>();
    save.mockReturnValue(result.promise);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.click(screen.getByRole('button', { name: 'Users', exact: true }));
    await screen.findByTestId('admin-unsaved-dialog');
    expect(screen.getByTestId('admin-unsaved-discard-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
    await act(async () => {
      result.resolve({});
      await result.promise;
    });
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Users', exact: true }));
    await screen.findByText('Users panel');
    expect(router.state.location.search.tab).toBe('users');
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
  });
});
