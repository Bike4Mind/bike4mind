import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeLakePicker from './DataLakeLakePicker';
import {
  useGetDataLakesWithRetrievability,
  useGetDataLakeTagCounts,
  useRefreshLakePickerReads,
} from '@client/app/hooks/data/dataLakes';

// The real lake-list and tag-count hooks run against this fake server, so the test sees what a
// user sees: names and counts cached before a GitHub lake's first sync renamed it and added files.
const server = vi.hoisted(() => ({
  name: 'New GitHub data lake',
  fileCount: 62,
  hold: null as Promise<void> | null,
}));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
// dataLakes.ts value-imports these for its other hooks; same stubs as dataLakes.test.ts.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => {
  const useSelectedAccount = (selector: (s: { selectedAccount: undefined }) => unknown) =>
    selector({ selectedAccount: undefined });
  useSelectedAccount.getState = () => ({ selectedAccount: undefined });
  return { useSelectedAccount };
});
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

const LAKE_ID = 'lake-1';

const respond = async (url: string) => {
  if (server.hold) await server.hold;
  if (url === '/api/data-lakes') {
    return {
      data: {
        data: [
          {
            id: LAKE_ID,
            name: server.name,
            slug: 'gh',
            fileTagPrefix: 'gh:',
            datalakeTag: 'datalake:gh',
            isOwn: true,
            canManage: true,
            retrievable: true,
          },
        ],
      },
    };
  }
  if (url === '/api/data-lakes/tag-counts') {
    return {
      data: {
        tagCounts: [],
        totalLakeFileCount: server.fileCount,
        lakeFileCounts: { 'datalake:gh': server.fileCount },
      },
    };
  }
  throw new Error(`unexpected GET ${url}`);
};

/** The Explorer's wiring of the picker, cut down to the reads the picker shows. */
function PickerHost() {
  const lakes = useGetDataLakesWithRetrievability('sess-1');
  const counts = useGetDataLakeTagCounts('datalakes');
  const refresh = useRefreshLakePickerReads('sess-1');
  return (
    <DataLakeLakePicker
      lakes={lakes.data}
      isLoading={lakes.isLoading}
      isError={lakes.isError}
      onRetry={() => void lakes.refetch()}
      selectedLakeIds={[LAKE_ID]}
      onChange={() => {}}
      lakeFileCounts={counts.data?.lakeFileCounts}
      totalFileCount={counts.data?.totalLakeFileCount}
      onOpen={refresh}
    />
  );
}

const appTheme = extendTheme({ ...getThemeConfig() });

const renderHost = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<PickerHost />, { wrapper: Wrapper });
};

const label = () => screen.getByTestId('datalake-lake-picker-label');
const count = () => screen.getByTestId('datalake-lake-picker-count');

/** Renders with the placeholder name and mid-sync count cached, then lets the sync finish server-side. */
const renderWithPlaceholderCached = async () => {
  renderHost();
  await waitFor(() => expect(label()).toHaveTextContent('New GitHub data lake'));
  expect(count()).toHaveTextContent('62 files');
  server.name = 'acme/docs';
  server.fileCount = 204;
};

describe('DataLakeLakePicker - refresh on open', () => {
  beforeEach(() => {
    server.name = 'New GitHub data lake';
    server.fileCount = 62;
    server.hold = null;
    apiGet.mockReset();
    apiGet.mockImplementation(respond);
  });

  it('shows the renamed lake and its final file count once opened, without a reload', async () => {
    await renderWithPlaceholderCached();
    const readsBeforeOpen = apiGet.mock.calls.length;

    fireEvent.click(screen.getByTestId('datalake-lake-picker-btn'));

    await waitFor(() => expect(label()).toHaveTextContent('acme/docs'));
    expect(count()).toHaveTextContent('204 files');
    expect(screen.getByTestId(`datalake-lake-picker-lake-${LAKE_ID}`)).toHaveTextContent('acme/docs');
    expect(apiGet.mock.calls.length).toBeGreaterThan(readsBeforeOpen);
  });

  it('keeps the cached rows on screen while the refresh is in flight, with no loading skeleton', async () => {
    await renderWithPlaceholderCached();
    let release: () => void = () => {};
    server.hold = new Promise<void>(resolve => (release = resolve));
    const readsBeforeOpen = apiGet.mock.calls.length;

    fireEvent.click(screen.getByTestId('datalake-lake-picker-btn'));

    await waitFor(() => expect(apiGet.mock.calls.length).toBeGreaterThan(readsBeforeOpen));
    expect(screen.queryByTestId('datalake-lake-picker-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId(`datalake-lake-picker-lake-${LAKE_ID}`)).toHaveTextContent('New GitHub data lake');

    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId(`datalake-lake-picker-lake-${LAKE_ID}`)).toHaveTextContent('acme/docs')
    );
    expect(count()).toHaveTextContent('204 files');
  });
});
