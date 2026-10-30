import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { parseAdminSearch } from '../adminTabParams';

vi.mock('./hooks/useEventMetrics', () => ({
  useEventMetrics: () => ({ data: [], isLoading: false, isFetching: false, isError: false, forceRefresh: vi.fn() }),
}));
vi.mock('./UserActivity', () => ({ UserActivityView: () => <div data-testid="user-activity-view" /> }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import EventMetricsTab from './index';

const theme = extendTheme({ ...getThemeConfig() });

async function renderTab(url: string) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: EventMetricsTab,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return router;
}

describe('EventMetricsTab views', () => {
  it('opens the By user grid from a deep link', async () => {
    await renderTab('/admin?tab=event-metrics&eventsView=by-user');
    expect(await screen.findByTestId('user-activity-view')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-tab')).toBeNull();
  });

  it('switches between the event charts and the By user grid through the URL', async () => {
    const router = await renderTab('/admin?tab=event-metrics');
    expect(await screen.findByTestId('overview-tab')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('event-metrics-view-by-user'));
    await waitFor(() => expect(router.state.location.search.eventsView).toBe('by-user'));
    expect(await screen.findByTestId('user-activity-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('event-metrics-view-events'));
    await waitFor(() => expect(router.state.location.search.eventsView).toBeUndefined());
  });
});
