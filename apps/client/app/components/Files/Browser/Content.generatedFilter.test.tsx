import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { searchCalls } = vi.hoisted(() => ({
  searchCalls: [] as { filters?: { generated?: boolean } }[],
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  usePaginatedSearchFabFiles: (params: { filters?: { generated?: boolean } }) => {
    searchCalls.push(params);
    return { data: { data: [], total: 0 }, isLoading: false, isPlaceholderData: false };
  },
  useSearchFabFiles: () => ({ data: { data: [], total: 0 }, isLoading: false }),
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
vi.mock('./MobileSearchFilter', () => ({ MobileSearchFilter: () => null }));
vi.mock('./UploadActionsSelect', () => ({ UploadActionsSelect: () => null }));
vi.mock('../../common/FileStorageBar', () => ({ default: () => null }));
vi.mock('../../common/ShareModal', () => ({ default: () => null }));
vi.mock('../../Knowledge/CreateKnowledgeFromUrl', () => ({ default: () => null }));
vi.mock('../../Tag/Form', () => ({ default: () => null }));
vi.mock('../../ResarchEngine/Modal', () => ({ default: () => null }));
vi.mock('@client/app/components/MobileTopBar', () => ({ MobileTopBar: () => null }));
vi.mock('@client/app/components/help', () => ({ FieldTooltip: () => null }));

import FileBrowserContent from './Content';
import { FileBrowserInstanceProvider, FileBrowserInstanceValue } from './instanceContext';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderContent = () => {
  const value: FileBrowserInstanceValue = {
    selectedIds: new Set(),
    setSelectedIds: vi.fn(),
    open: true,
    setOpen: vi.fn(),
    fileToShare: null,
    setFileToShare: vi.fn(),
    config: {},
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

describe('FileBrowserContent - Generated quick filter', () => {
  beforeEach(() => {
    searchCalls.length = 0;
  });

  it('searches with filters.generated and leaves the home view for the list view', () => {
    renderContent();
    expect(screen.getByTestId('stub-home-view')).toBeInTheDocument();
    expect(searchCalls.every(call => call.filters?.generated !== true)).toBe(true);

    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));

    expect(screen.queryByTestId('stub-home-view')).not.toBeInTheDocument();
    expect(searchCalls[searchCalls.length - 1].filters?.generated).toBe(true);
  });
});
