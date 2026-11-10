import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import type { AdminModelListResponse, AdminModelRow, AdminModelStatus, AdminModelView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { parseAdminSearch } from '../adminTabParams';
import { UndoToastProvider } from '../shared';
import { parseModelDetailSearch } from './modelDetailSearch';

/**
 * Test helpers for the Models console. Callers mock '@client/app/contexts/ApiContext' and
 * '@client/app/contexts/UserContext' themselves (vi.mock is hoisted per file).
 */

const theme = extendTheme({ ...getThemeConfig() });

export const modelRow = (overrides: Partial<AdminModelRow> = {}): AdminModelRow => ({
  id: 'example-text-1',
  name: 'Example Text 1',
  type: 'text',
  backend: 'anthropic',
  private: false,
  freeToRun: false,
  status: 'listed',
  reasons: [],
  rank: 2,
  rankProvisional: false,
  origin: 'default',
  adminEdited: false,
  keyPresent: true,
  access: {
    entry: { enabled: true, allowedUserTags: [], allowedEntitlements: ['base'], updatedAt: '2026-11-01T00:00:00.000Z' },
    everyone: true,
    adminsOnly: false,
    freeTierLocked: false,
  },
  price: { source: 'row', unit: 'per_token', pricing: { '0': { input: 2.5e-6, output: 1e-5 } }, effectiveFrom: '' },
  lifecycle: {},
  lifecycleSuggestion: null,
  firstSeenAt: null,
  profileOnlyFoundation: false,
  ...overrides,
});

const zeroCounts = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;

export const listResponse = (
  models: AdminModelRow[],
  overrides: Partial<Omit<AdminModelListResponse, 'models' | 'counts' | 'viewCounts'>> & {
    counts?: Partial<AdminModelListResponse['counts']>;
    viewCounts?: Partial<Record<AdminModelView, number>>;
  } = {}
): AdminModelListResponse => {
  const statuses: AdminModelStatus[] = ['listed', 'limited', 'needs-review', 'hidden', 'retiring', 'retired'];
  const views: AdminModelView[] = ['all', 'needs-review', 'listed', 'hidden', 'retiring'];
  return {
    total: models.length,
    page: 1,
    pageSize: 50,
    foundationIds: 0,
    facets: { providers: ['anthropic', 'openai'], types: ['text', 'image'] },
    ...overrides,
    models,
    counts: { ...zeroCounts(statuses), ...overrides.counts },
    viewCounts: { ...zeroCounts(views), ...overrides.viewCounts },
  };
};

function DetailProbe() {
  const { _splat } = useParams({ strict: false }) as { _splat?: string };
  const search = useSearch({ strict: false }) as { tab?: string };
  return <div data-testid="probe-detail" data-id={_splat} data-tab={search.tab ?? ''} />;
}

function RunProbe() {
  const { runId } = useParams({ strict: false }) as { runId?: string };
  return <div data-testid="probe-run" data-id={runId} />;
}

/** Renders `Admin` at `/admin` under a memory router, with the detail and run routes probed. */
type RouteView = () => ReactElement | null;

export async function renderModelsRoute(
  url: string,
  Admin: RouteView,
  {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    Detail = DetailProbe,
  }: { queryClient?: QueryClient; Detail?: RouteView } = {}
) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: Admin,
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: '/admin/models/$',
    validateSearch: parseModelDetailSearch,
    component: Detail,
  });
  const run = createRoute({ getParentRoute: () => root, path: '/admin/models/runs/$runId', component: RunProbe });
  const router = createRouter({
    routeTree: root.addChildren([admin, detail, run]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <UndoToastProvider>{node}</UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
  render(wrap(<RouterProvider router={router} />));
  return { router, queryClient };
}

/** An axios-shaped API failure. */
export const apiFailure = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
