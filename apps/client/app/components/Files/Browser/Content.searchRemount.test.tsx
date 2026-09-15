import { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';

/**
 * Guards the file browser's single list render site. Content used to host FileBrowserList in two
 * mutually-exclusive branches switched on hasFilters; since React reconciles children by position,
 * the first committed search term unmounted the whole list subtree and mounted a fresh one, wiping
 * every row's local state - an open inline rename included. keepPreviousData keeps the rows' DATA
 * across that refetch, so the blank-list symptom disappeared while the lost-rename one did not.
 *
 * Real Filter (debounce and all) and real List; the row is stubbed with the smallest thing that
 * behaves like Item.tsx's `editMode` - useState that survives re-render and dies on unmount.
 */

const { rowMounts } = vi.hoisted(() => ({ rowMounts: new Map<string, number>() }));

const testFiles = [
  { id: 'f1', fileName: 'cat.png', fileSize: 100, userId: 'u1', mimeType: 'image/png', type: 'file' },
  { id: 'f2', fileName: 'dog.png', fileSize: 200, userId: 'u1', mimeType: 'image/png', type: 'file' },
  { id: 'f3', fileName: 'notes.txt', fileSize: 300, userId: 'u1', mimeType: 'text/plain', type: 'file' },
] as unknown as IFabFileDocument[];

// Every search term the hook is asked for, in order - the observable signal that the debounced
// filter change has reached the query, so the test never has to sleep on the 500ms debounce.
const searchParams: (string | undefined)[] = [];

vi.mock('./Item', async () => {
  const { useState, useEffect } = await import('react');
  const StubRow = ({ file }: { file: IFabFileDocument }) => {
    const [editing, setEditing] = useState(false);
    useEffect(() => {
      rowMounts.set(file.id, (rowMounts.get(file.id) ?? 0) + 1);
    }, [file.id]);
    return (
      <div data-testid={`row-${file.id}`}>
        {file.fileName}
        <button data-testid={`row-edit-${file.id}`} onClick={() => setEditing(true)}>
          edit
        </button>
        {editing && <span data-testid={`row-editing-${file.id}`} />}
      </div>
    );
  };
  return { default: StubRow };
});

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  usePaginatedSearchFabFiles: (params?: { search?: string }) => {
    searchParams.push(params?.search);
    // Mirrors keepPreviousData: the previous rows stay put while a new term is in flight.
    return { data: { data: testFiles, total: testFiles.length }, isLoading: false, isPlaceholderData: false };
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

// Heavy children not under test - Filter and List are deliberately NOT mocked.
// The browser opens on the Overview tab, which renders no paginated list; this stub is just a
// switch into List view (the real ViewActions pulls in chrome this test does not exercise).
vi.mock('./ViewActions', () => ({
  default: ({ value, onChange }: { value: { viewMode?: string }; onChange: (v: { viewMode: string }) => void }) => (
    <button data-testid="stub-view-mode-list" onClick={() => onChange({ ...value, viewMode: 'list' })}>
      list view
    </button>
  ),
}));
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
  // Content renders the view switcher twice (mobile + desktop); either one drives the same state.
  fireEvent.click(screen.getAllByTestId('stub-view-mode-list')[0]);
};

/** Type a term and wait for the debounced filter change to reach the query. */
const search = async (term: string) => {
  const input = screen.getByTestId('file-browser-search-input').querySelector('input');
  fireEvent.change(input as HTMLInputElement, { target: { value: term } });
  await waitFor(() => expect(searchParams).toContain(term), { timeout: 2_000 });
};

describe('FileBrowserContent - list survives the unfiltered/filtered switch', () => {
  beforeEach(() => {
    rowMounts.clear();
    searchParams.length = 0;
  });

  it('keeps per-row state (an open inline rename) when a search term commits', async () => {
    renderContent();

    fireEvent.click(screen.getByTestId('row-edit-f1'));
    expect(screen.getByTestId('row-editing-f1')).toBeInTheDocument();

    await search('ca');

    expect(screen.getByTestId('row-editing-f1')).toBeInTheDocument();
  });

  it('does not remount rows when the search term commits or changes', async () => {
    renderContent();
    expect(rowMounts.get('f1')).toBe(1);

    await search('ca');
    await search('cat');
    // Back to the unfiltered view - the reverse crossing of the same boundary.
    await search('');

    expect(rowMounts.get('f1')).toBe(1);
  });
});
