import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type SearchCall = { filters?: Record<string, unknown> };
const { searchCalls, recentCalls } = vi.hoisted(() => ({
  searchCalls: [] as SearchCall[],
  recentCalls: [] as SearchCall[],
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  usePaginatedSearchFabFiles: (params: SearchCall) => {
    searchCalls.push(params);
    return { data: { data: [], total: 0 }, isLoading: false, isPlaceholderData: false };
  },
  useSearchFabFiles: (params: SearchCall) => {
    recentCalls.push(params);
    return { data: { data: [], total: 0 }, isLoading: false };
  },
  useBulkDeleteFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFabFile: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFabFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/tag', () => ({
  useGetFileTags: () => ({ data: [] }),
  useToggleTagToFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFileTag: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({ useUpdateSession: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { model: string }) => unknown) => selector({ model: 'gpt' }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 's1', currentSession: null }),
  useWorkBenchFiles: () => [],
  useWorkBenchStore: { getState: () => ({ setWorkBenchFiles: vi.fn() }) },
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: () => void }) => unknown) => selector({ openManager: vi.fn() }),
}));
vi.mock('../../Knowledge/KnowledgeModal', () => {
  const state = { setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() };
  return { useKnowledgeModal: (selector: (s: typeof state) => unknown) => selector(state) };
});

vi.mock('./ViewActions', () => ({ default: () => null }));
vi.mock('./TagSidebar', () => ({ default: () => null }));
vi.mock('./TagView', () => ({ TagViewPanel: () => null }));
vi.mock('./HomeView', () => ({ HomeViewPanel: () => <div data-testid="stub-home-view" /> }));
// Forwards the props Content passes, so the mobile wiring itself is exercised (the desktop toggle shares its test id).
vi.mock('./MobileSearchFilter', () => ({
  MobileSearchFilter: (props: { onGeneratedChange?: unknown; onFileTypeChange?: unknown }) => (
    <div
      data-testid="stub-mobile-filter"
      data-source-control={String(Boolean(props.onGeneratedChange))}
      data-type-control={String(Boolean(props.onFileTypeChange))}
    />
  ),
}));
vi.mock('@client/app/hooks/data/fileStars', () => ({
  useGenerationModelIds: () => ({ data: ['flux-pro', 'veo-3'] }),
}));
// Rendered by the list only while Content's hasFilters is true.
vi.mock('./TagFilter', () => ({ default: () => <div data-testid="stub-tag-filters" /> }));
vi.mock('./UploadActionsSelect', () => ({ UploadActionsSelect: () => null }));
vi.mock('../../common/FileStorageBar', () => ({ default: () => null }));
vi.mock('../../common/StorageBreakdown', () => ({ default: () => null }));
vi.mock('../../common/ShareModal', () => ({ default: () => null }));
vi.mock('../../Knowledge/CreateKnowledgeFromUrl', () => ({ default: () => null }));
vi.mock('../../Tag/Form', () => ({ default: () => null }));
vi.mock('../../ResarchEngine/Modal', () => ({ default: () => null }));
vi.mock('@client/app/components/MobileTopBar', () => ({ MobileTopBar: () => null }));
vi.mock('@client/app/components/help', () => ({ FieldTooltip: () => null }));

import FileBrowserContent from './Content';
import { FileBrowserConfig, FileBrowserInstanceProvider, FileBrowserInstanceValue } from './instanceContext';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderContent = (config: FileBrowserConfig) => {
  const value: FileBrowserInstanceValue = {
    selectedIds: new Set(),
    setSelectedIds: vi.fn(),
    open: true,
    setOpen: vi.fn(),
    fileToShare: null,
    setFileToShare: vi.fn(),
    config,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <FileBrowserInstanceProvider value={value}>{children}</FileBrowserInstanceProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
  render(<FileBrowserContent />, { wrapper });
};

const lastSearch = () => searchCalls[searchCalls.length - 1];

describe('FileBrowserContent - locked and initial filters', () => {
  beforeEach(() => {
    searchCalls.length = 0;
    recentCalls.length = 0;
  });

  it('ANDs locked filters into the list and the recent query, and shows them as chips', () => {
    renderContent({ lockedFilters: { source: 'generated', type: 'image' } });

    expect(lastSearch().filters).toMatchObject({ generated: true, type: 'image' });
    expect(recentCalls[recentCalls.length - 1].filters).toMatchObject({ generated: true, type: 'image' });
    expect(screen.getByTestId('file-browser-locked-filter-chip-source')).toHaveTextContent('Generated');
    expect(screen.getByTestId('file-browser-locked-filter-chip-type')).toHaveTextContent('Image');
  });

  it('gives locked filters no control the user could use to remove them', () => {
    renderContent({ lockedFilters: { source: 'generated', type: 'image' } });

    expect(screen.queryByTestId('file-browser-generated-filter-btn')).not.toBeInTheDocument();
    expect(document.querySelector('.file-browser-filter-type-select')).toBeNull();
    expect(screen.getByTestId('stub-mobile-filter')).toHaveAttribute('data-source-control', 'false');
    expect(screen.getByTestId('stub-mobile-filter')).toHaveAttribute('data-type-control', 'false');
    expect(within(screen.getByTestId('file-browser-locked-filter-chip-source')).queryByRole('button')).toBeNull();
  });

  it('keeps the locked filter when the user changes their own filters', () => {
    renderContent({ lockedFilters: { source: 'generated' }, enableStar: true });

    fireEvent.click(screen.getByTestId('file-browser-starred-filter-btn'));

    expect(lastSearch().filters).toMatchObject({ generated: true, starred: true });
  });

  it('leaves an unlocked browser exactly as before: no filter row, all controls', () => {
    renderContent({});

    expect(screen.queryByTestId('file-browser-library-filters')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-browser-generated-filter-btn')).toBeInTheDocument();
    expect(screen.getByTestId('stub-mobile-filter')).toHaveAttribute('data-type-control', 'true');
    expect(lastSearch().filters).toBeUndefined();
  });

  it('starts from the initial filters and view, which the user can then clear', () => {
    renderContent({ initialFilters: { starred: true }, initialViewMode: 'grid', enableStar: true });

    expect(screen.queryByTestId('stub-home-view')).not.toBeInTheDocument();
    expect(lastSearch().filters).toMatchObject({ starred: true });

    fireEvent.click(screen.getByTestId('file-browser-starred-filter-btn'));

    expect(lastSearch().filters?.starred).toBeUndefined();
  });

  it('filters by the selected generation model', () => {
    renderContent({ lockedFilters: { source: 'generated' }, enableModelFilter: true });

    fireEvent.click(within(screen.getByTestId('file-browser-model-filter-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'veo-3' }));

    expect(lastSearch().filters).toMatchObject({ generated: true, model: 'veo-3' });
  });
});
