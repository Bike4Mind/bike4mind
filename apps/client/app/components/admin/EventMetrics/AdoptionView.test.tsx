import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { ADOPTION_FEATURES, ADOPTION_LABELS, type FeatureAdoption } from '@client/app/utils/featureAdoption';
import { parseAdminSearch } from '../adminTabParams';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
import { AdoptionView } from './AdoptionView';

const theme = extendTheme({ ...getThemeConfig() });
const data: FeatureAdoption = {
  query: { accounts: 'external', client: 'all', days: 7 },
  window: { from: '2026-06-08', to: '2026-06-14', previousFrom: '2026-06-01', previousTo: '2026-06-07' },
  coverage: 'unknown',
  features: ADOPTION_FEATURES.map(feature => ({
    feature,
    label: ADOPTION_LABELS[feature],
    successfulUsers: 1,
    previousUsers: feature === 'chat' ? 1 : null,
    userChange: feature === 'chat' ? 0 : null,
    successfulOperations: 2,
    repeatUsers: feature === 'chat' ? 1 : null,
    repeatDenominator: feature === 'chat' ? 1 : null,
    users: [{ userId: 'u1', operations: 2, previousOperations: feature === 'chat' ? 1 : 0 }],
  })),
};
async function renderView(url = '/admin?tab=event-metrics&eventsView=adoption') {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: AdoptionView,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return router;
}
beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockImplementation(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return {
      data: {
        ...data,
        query: {
          accounts: params.get('accounts'),
          client: params.get('client'),
          days: Number(params.get('days')),
          ...(params.get('end') ? { end: params.get('end') } : {}),
        },
      },
    };
  });
});
describe('feature adoption view', () => {
  it('defaults External, displays small repeat cohorts as counts, and explains unavailable coverage', async () => {
    await renderView();
    const row = await screen.findByTestId('adoption-row-chat');
    expect(row).toHaveTextContent('1 / 1');
    expect(screen.getByTestId('adoption-audience-external')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('feature-adoption-view')).toHaveTextContent('Discovery is not measured');
    expect(screen.getByTestId('feature-adoption-view')).toHaveTextContent('Maturity is unknown');
    expect(screen.getByTestId('adoption-row-image_edit')).toHaveTextContent('Unavailable');
    expect(row.textContent).not.toContain('%');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/analytics/feature-adoption?accounts=external&client=all&days=7');
  });
  it('preserves audience/date/client in URLs, feature detail and export', async () => {
    const router = await renderView(
      '/admin?tab=event-metrics&eventsView=adoption&adoptionAccounts=internal&adoptionClient=api&adoptionDays=28&adoptionEnd=2026-06-14&adoptionFeature=chat'
    );
    const detail = await screen.findByTestId('adoption-detail');
    expect(detail).toHaveTextContent('u1');
    expect(within(screen.getByTestId('adoption-users')).getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('adoption-close-detail'));
    await waitFor(() => expect(router.state.location.search.adoptionFeature).toBeUndefined());
    fireEvent.click(screen.getByTestId('adoption-detail-chat'));
    await waitFor(() => expect(router.state.location.search.adoptionFeature).toBe('chat'));
    fireEvent.click(screen.getByTestId('adoption-audience-all'));
    await waitFor(() => expect(router.state.location.search.adoptionAccounts).toBe('all'));
    expect(router.state.location.search).toMatchObject({
      adoptionClient: 'api',
      adoptionDays: '28',
      adoptionEnd: '2026-06-14',
      adoptionFeature: 'chat',
    });
    await waitFor(() => expect(screen.getByTestId('adoption-export')).not.toBeDisabled());
    const create = vi.fn(() => 'blob:export');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByTestId('adoption-export'));
    const blob = create.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob).toBeDefined();
    const exported = JSON.parse(
      await new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob!);
      })
    );
    expect(exported.query).toEqual({ accounts: 'all', client: 'api', days: 28, end: '2026-06-14' });
    expect(exported.features).toEqual(data.features);
    expect(revoke).toHaveBeenCalledWith('blob:export');
    click.mockRestore();
  });
  it('shows loading, failure and invalid-filter states without exporting stale numbers', async () => {
    mocks.get.mockRejectedValue(new Error('Query failed'));
    await renderView();
    expect(screen.getByTestId('feature-adoption-view')).toHaveTextContent('Loading feature adoption');
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Query failed');
    expect(screen.getByTestId('adoption-export')).toBeDisabled();
  });
  it('rejects malformed URL filters without making a request', async () => {
    await renderView('/admin?tab=event-metrics&eventsView=adoption&adoptionDays=999');
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Invalid adoption filters');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
