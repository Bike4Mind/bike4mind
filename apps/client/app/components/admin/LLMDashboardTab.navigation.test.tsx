import { StrictMode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type LLMModelConfig } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { parseAdminSearch } from './adminTabParams';
import { useAdminModal } from './useAdminModal';
import { useAdminTabUrlSync } from './useAdminTabUrlSync';

const models = [
  { id: 'gpt-5', name: 'GPT-5' },
  { id: 'claude-opus', name: 'Claude Opus' },
].map(
  model =>
    ({
      ...model,
      type: 'text',
      backend: ModelBackend.OpenAI,
      enabled: true,
      allowedUserTags: [],
      allowedEntitlements: [],
    }) as unknown as LLMModelConfig
);

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: models, isPending: false, isLoading: false, isFetching: false, error: null }),
}));
vi.mock('@client/app/hooks/data/llmModelConfig', () => ({
  useLLMModelConfigurationsWithDefaults: () => ({
    data: models.map(model => ({ ...model, accessEntry: null })),
    isLoading: false,
    refetch: vi.fn(),
  }),
  useSaveLLMModelConfigurations: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ data: { users: [] }, isLoading: false }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import LLMDashboardTab from './LLMDashboardTab';

const theme = extendTheme({ ...getThemeConfig() });

// The admin shell in miniature: a store-first tab switch (as the sidebar does) and the URL-to-store sync.
function Console() {
  const activeTab = useAdminModal(state => state.activeTab);
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  useAdminTabUrlSync(activeTab, setActiveTab);
  return (
    <>
      <button onClick={() => setActiveTab(AdminTab.Users)}>Users</button>
      {activeTab === AdminTab.LLMDashboard ? <LLMDashboardTab /> : <p>Users panel</p>}
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
    history: createMemoryHistory({ initialEntries: ['/admin?tab=llm-dashboard'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </StrictMode>
  );
  await screen.findByTestId('llm-dashboard-root');
  return router;
}

const toggle = (modelId: string) => {
  const input = screen.getByTestId(`llm-dashboard-toggle-${modelId}`).querySelector('input');
  if (!input) throw new Error(`No switch input for ${modelId}`);
  fireEvent.click(input);
  return input;
};

beforeEach(() => useAdminModal.setState(useAdminModal.getInitialState()));
afterEach(() => {
  cleanup();
  useAdminModal.setState(useAdminModal.getInitialState());
});

describe('LLMDashboardTab leave-page guard with the real router and tab store', () => {
  it('asks before a sidebar switch drops unsaved model edits, and keeps them on Keep editing', async () => {
    const router = await renderConsole();
    const input = toggle('gpt-5');
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByTestId('admin-unsaved-dialog');
    expect(screen.getByTestId('llm-dashboard-root')).toBeInTheDocument();
    expect(router.state.location.search.tab).toBe('llm-dashboard');

    fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
    await act(async () => {});
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
    expect(input).not.toBeChecked();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    fireEvent.click(await screen.findByTestId('admin-unsaved-discard-btn'));
    await screen.findByText('Users panel');
    expect(router.state.location.search.tab).toBe('users');
  });

  it('switches tabs straight away when nothing is unsaved', async () => {
    const router = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByText('Users panel');
    expect(screen.queryByTestId('admin-unsaved-dialog')).toBeNull();
    expect(router.state.location.search.tab).toBe('users');
  });
});
