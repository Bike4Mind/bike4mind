import { INTEGRATION_DEMAND_SEARCH_KEYS } from '../integrationDemandSearch';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { adminSearchForTab, parseAdminSearch } from '../adminTabParams';
import { FilterBar } from './FilterBar';
import { SavedViews } from './SavedViews';
import { readAdminListState, useAdminListUrlState } from './useAdminListUrlState';

const theme = extendTheme({ ...getThemeConfig() });
const keys = INTEGRATION_DEMAND_SEARCH_KEYS;
function ListExample() {
  const [state, change] = useAdminListUrlState(keys);
  return (
    <>
      <SavedViews
        views={[
          { id: 'live', label: 'Live', filters: { stage: 'ga' } },
          { id: 'all', label: 'All', filters: {} },
        ]}
        state={state}
        onChange={change}
      />
      <FilterBar
        state={state}
        onChange={change}
        filters={[
          {
            id: 'stage',
            label: 'Stage',
            options: [
              { value: 'planned', label: 'Roadmap' },
              { value: 'ga', label: 'Live' },
            ],
          },
        ]}
      />
    </>
  );
}
async function renderList(url: string) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: ListExample,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(
    <CssVarsProvider theme={theme}>
      <RouterProvider router={router} />
    </CssVarsProvider>
  );
  return router;
}

describe('URL-synced filters and saved views', () => {
  it('restores filters and a selected view from a deep link', async () => {
    await renderList('/admin?tab=integration-demand&demandQuery=calendar&demandStage=ga&demandView=live');
    expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('calendar');
    expect(screen.getByTestId('admin-filter-stage')).toHaveTextContent('Live');
    expect(screen.getByTestId('admin-saved-view-live-btn')).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes filter changes to the real router, keeps the active tab and clears view selection', async () => {
    const router = await renderList('/admin?tab=integration-demand&demandView=live&demandStage=ga');
    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'calendar' } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: 'integration-demand',
        demandQuery: 'calendar',
        demandStage: 'ga',
      })
    );
    expect(router.state.location.search.demandView).toBeUndefined();
    fireEvent.click(screen.getByTestId('admin-filter-clear-stage-btn'));
    await waitFor(() => expect(router.state.location.search.demandStage).toBeUndefined());
    fireEvent.click(screen.getByTestId('admin-filter-stage'));
    fireEvent.click(screen.getByTestId('admin-filter-stage-planned'));
    await waitFor(() => expect(router.state.location.search.demandStage).toBe('planned'));
  });

  it('keeps every keystroke while typing and writes the query to the URL once typing pauses', async () => {
    const router = await renderList('/admin?tab=integration-demand&demandView=live');
    const input = screen.getByTestId('admin-filter-search-input');
    await userEvent.type(input, 'calendar sync');
    expect(input).toHaveValue('calendar sync');
    await waitFor(() => expect(router.state.location.search.demandQuery).toBe('calendar sync'));
    expect(router.state.location.search.demandView).toBeUndefined();
    expect(input).toHaveValue('calendar sync');
  });

  it('applies saved views atomically and removes the previous filters', async () => {
    const router = await renderList('/admin?tab=integration-demand&demandQuery=calendar&demandStage=planned');
    fireEvent.click(screen.getByTestId('admin-saved-view-live-btn'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        demandStage: 'ga',
        demandView: 'live',
      })
    );
    expect(router.state.location.search.demandQuery).toBeUndefined();
    expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('');
    fireEvent.click(screen.getByTestId('admin-saved-view-all-btn'));
    await waitFor(() => expect(router.state.location.search.demandStage).toBeUndefined());
    expect(screen.queryByTestId('admin-filter-clear-stage-btn')).not.toBeInTheDocument();
  });

  it('restores a newly navigated URL and drops owned params when switching tabs', async () => {
    const router = await renderList('/admin?tab=integration-demand');
    await router.navigate({
      to: '/admin',
      search: { tab: 'integration-demand', demandQuery: 'maps', demandStage: 'planned' },
    });
    await waitFor(() => expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('maps'));
    const switched = adminSearchForTab(router.state.location.search, 'users');
    expect(switched.demandQuery).toBeUndefined();
    expect(switched.demandStage).toBeUndefined();
    expect(switched.demandView).toBeUndefined();
  });

  it('rejects malformed and oversized URL values at the boundary', () => {
    expect(readAdminListState({ demandQuery: ['oops'], demandStage: 4, demandView: 'x'.repeat(501) }, keys)).toEqual({
      query: '',
      filters: { stage: '' },
      view: '',
    });
  });
});
