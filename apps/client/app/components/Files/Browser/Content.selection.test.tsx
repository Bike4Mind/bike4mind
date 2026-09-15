import { IFabFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileBrowserInstanceProvider, type FileBrowserInstanceValue } from './instanceContext';

const h = vi.hoisted(() => ({
  bulkDelete: vi.fn(),
  // Records what the confirmation was actually asked to say, and runs onOk, so a test can assert
  // that the dialog's own count and the ids that reach the mutation are the same list.
  confirmCalls: [] as { title: string }[],
  queryPages: [] as number[],
  toastError: vi.fn(),
}));
const confirmRun = vi.fn((opts: { title: string; onOk?: () => void | Promise<void> }) => {
  h.confirmCalls.push({ title: opts.title });
  return opts.onOk?.();
});

// Two full pages, so the bottom bar renders its pager (it needs totalPages > 1) and page 2 holds
// a disjoint set of files - which is the whole point: nothing selected on page 1 can resolve here.
const PAGE_SIZE = 20;
const page = (n: number): IFabFileDocument[] =>
  Array.from({ length: PAGE_SIZE }, (_, i) => ({
    id: `p${n}f${i}`,
    fileName: `page ${n} file ${i}`,
    userId: 'u1',
    tags: [],
  })) as unknown as IFabFileDocument[];

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  usePaginatedSearchFabFiles: (params: { page: number }) => {
    h.queryPages.push(params.page);
    return { data: { data: page(params.page), total: PAGE_SIZE * 2 }, isLoading: false, isPlaceholderData: false };
  },
  useSearchFabFiles: () => ({ data: { data: [], total: 0 }, isLoading: false }),
  useBulkDeleteFiles: () => ({ mutateAsync: h.bulkDelete }),
  useCreateFabFile: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => confirmRun }));
vi.mock('sonner', () => ({ toast: { error: h.toastError, info: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/hooks/data/tag', () => ({
  useGetFileTags: () => ({ data: [] }),
  useToggleTagToFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFileTag: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: [] }),
  useAddFilesToLake: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({ useUpdateSession: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
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
// Stubbed down to the one prop the sort test drives. The real List's column headers call exactly
// this, so the stub reaches `handleSortChange` the same way a click on "Name" would, without
// pulling in List's rows and their own queries.
vi.mock('./List', () => ({
  default: ({ onSortChange }: { onSortChange: (f: string, d: string) => void }) => (
    <button data-testid="stub-sort-by-name" onClick={() => onSortChange('fileName', 'asc')}>
      sort
    </button>
  ),
}));
vi.mock('./Filter', () => ({ default: () => null }));
vi.mock('./ViewActions', () => ({
  default: ({ value, onChange }: { value: { viewMode?: string }; onChange: (v: unknown) => void }) => (
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

const appTheme = extendTheme({ ...getThemeConfig() });

/**
 * A REAL selection setter, not a spy. The behaviour under test is the component clearing the
 * selection and then acting on what is left, so a `vi.fn()` paired with a frozen `selectedIds`
 * would swallow the clear and let every assertion below pass against a component that never did it.
 */
const renderContent = (initialIds: string[]) => {
  const Harness = () => {
    const [selectedIds, setSelectedIds] = useState(new Set<string>());
    const value = {
      selectedIds,
      setSelectedIds,
      open: true,
      setOpen: vi.fn(),
      fileToShare: null,
      setFileToShare: vi.fn(),
      config: {},
    } as unknown as FileBrowserInstanceValue;
    return (
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <FileBrowserInstanceProvider value={value}>
            <button data-testid="seed-selection" onClick={() => setSelectedIds(new Set(initialIds))}>
              seed
            </button>
            <FileBrowserContent />
          </FileBrowserInstanceProvider>
        </CssVarsProvider>
      </QueryClientProvider>
    );
  };
  render(<Harness />);
  // Order matters. The component starts on Overview, whose file set is a different list entirely,
  // so crossing into the paginated view is itself one of the boundaries that clears a selection -
  // seeding before the switch would be cleared by the behaviour under test and prove nothing.
  fireEvent.click(screen.getAllByTestId('stub-view-mode-list')[0]);
  fireEvent.click(screen.getByTestId('seed-selection'));
};

describe('FileBrowserContent bulk selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.confirmCalls.length = 0;
    h.queryPages.length = 0;
  });

  it('drops the selection when the page changes, so no action can outlive the files it named', () => {
    renderContent(['p1f0', 'p1f1']);
    expect(screen.getByTestId('file-browser-delete-btn')).toBeTruthy();

    fireEvent.click(screen.getByTestId('file-browser-next-page-btn'));

    // The refetch really did move - without this the assertion below would also hold on a component
    // that simply never paged.
    expect(h.queryPages).toContain(2);
    expect(screen.queryByTestId('file-browser-delete-btn')).toBeNull();
  });

  it('drops the selection when the sort changes, which reshuffles the same page', () => {
    renderContent(['p1f0']);
    expect(screen.getByTestId('file-browser-delete-btn')).toBeTruthy();

    // Sorting is the second boundary that replaces the visible set while the id set survives.
    fireEvent.click(screen.getAllByTestId('stub-sort-by-name')[0]);

    expect(screen.queryByTestId('file-browser-delete-btn')).toBeNull();
  });

  it('deletes only the ids it resolved, never the raw selection', async () => {
    // A refetch can drop a file from the current page while its id stays selected. That id is one
    // the confirmation never described, so it must not reach the mutation.
    renderContent(['p1f0', 'vanished-under-us']);

    fireEvent.click(screen.getByTestId('file-browser-delete-btn'));

    expect(h.confirmCalls[0].title).toBe('Delete 1 file(s)');
    expect(h.bulkDelete).toHaveBeenCalledWith(['p1f0']);
  });

  it('refuses outright when nothing in the selection resolves, rather than confirming a zero', () => {
    // The shape the old code turned into a silent mass delete: it rendered "Delete 0 file(s)" and
    // then passed the whole stale set to the mutation.
    renderContent(['gone-1', 'gone-2']);

    fireEvent.click(screen.getByTestId('file-browser-delete-btn'));

    expect(confirmRun).not.toHaveBeenCalled();
    expect(h.bulkDelete).not.toHaveBeenCalled();
    // The exact key, not merely "a toast": a guard added ahead of this bail would otherwise keep
    // the test green while the branch it names goes dead.
    expect(h.toastError).toHaveBeenCalledWith('file_browser.selection_stale');
  });
});
