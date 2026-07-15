import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';

/**
 * Verifies the embedded-picker branches of FileBrowserContent: when the instance
 * context supplies config.onAdd / config.onDelete, the bottom-bar Add and Delete
 * defer to those callbacks instead of the global session-add / file-delete paths.
 * All of Content's data hooks and heavy children are mocked; the real bottom bar
 * (Actions) is kept so the actual buttons are clicked.
 */

const testFile = {
  id: 'f1',
  fileName: 'File 1',
  fileSize: 100,
  userId: 'u1',
  mimeType: 'text/plain',
  type: 'file',
  createdAt: '2026-01-01T00:00:00Z',
} as unknown as IFabFileDocument;

const updateSessionMutate = vi.fn();
// useConfirmation returns a runner that immediately invokes onOk, so delete flows resolve synchronously.
const confirmRun = vi.fn((opts: { onOk?: () => void | Promise<void> }) => opts.onOk?.());

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  usePaginatedSearchFabFiles: () => ({ data: { data: [testFile], total: 1 }, isLoading: false, isFetching: false }),
  useSearchFabFiles: () => ({ data: { data: [], total: 0 }, isLoading: false }),
  useBulkDeleteFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFabFile: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/tag', () => ({
  useGetFileTags: () => ({ data: [] }),
  useToggleTagToFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFileTag: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({ useUpdateSession: () => ({ mutate: updateSessionMutate }) }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => confirmRun }));
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

// Heavy children not under test - stub to nothing.
vi.mock('./Filter', () => ({ default: () => null }));
vi.mock('./List', () => ({ default: () => null }));
vi.mock('./ViewActions', () => ({ default: () => null }));
vi.mock('./TagSidebar', () => ({ default: () => null }));
vi.mock('./TagView', () => ({ TagViewPanel: () => null }));
vi.mock('./HomeView', () => ({ HomeViewPanel: () => null }));
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
import { FileBrowserInstanceProvider, FileBrowserConfig, FileBrowserInstanceValue } from './instanceContext';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderContent = (config: FileBrowserConfig) => {
  const setSelectedIds = vi.fn();
  const value: FileBrowserInstanceValue = {
    selectedIds: new Set(['f1']),
    setSelectedIds,
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
  return { setSelectedIds };
};

describe('FileBrowserContent embedded config', () => {
  beforeEach(() => {
    updateSessionMutate.mockClear();
    confirmRun.mockClear();
  });

  it('Add calls config.onAdd with the selected files and skips the session update', () => {
    const onAdd = vi.fn();
    renderContent({ onAdd });

    fireEvent.click(screen.getByTestId('file-browser-add-files-btn'));

    expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({ id: 'f1' })]);
    expect(updateSessionMutate).not.toHaveBeenCalled();
  });

  it('Delete calls config.onDelete with the selected ids (batched) instead of deleting the files', () => {
    const onDelete = vi.fn();
    renderContent({ onDelete });

    fireEvent.click(screen.getByTestId('file-browser-delete-btn'));

    expect(confirmRun).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(['f1']);
  });
});
