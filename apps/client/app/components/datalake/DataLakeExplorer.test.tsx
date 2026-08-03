import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// Chat-first mode opens a clicked file INLINE in the KnowledgeViewer by adding it to the
// session workbench and switching layout to `vertical`. Spy on those two seams.
const { setWorkBenchFiles, setSessionLayout, sessionState } = vi.hoisted(() => ({
  setWorkBenchFiles: vi.fn(),
  setSessionLayout: vi.fn(),
  // Mutable so the /new (deferred creation, no session yet) case can null it per-test.
  sessionState: { currentSessionId: 'sess-1' as string | null },
}));
vi.mock('@client/app/contexts/SessionsContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/SessionsContext')>()),
  useSessions: () => ({ currentSessionId: sessionState.currentSessionId }),
  useWorkBenchActions: () => ({ setWorkBenchFiles }),
}));
vi.mock('@client/app/hooks/useSessionLayout', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/useSessionLayout')>()),
  setSessionLayout,
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({
    data: { tagCounts: [], uniqueArticleCounts: { total: 0 } },
    isLoading: false,
    isError: false,
  }),
  // id query (deep-link) resolves to a file; tag query resolves empty.
  useGetDataLakeArticles: (params?: { id?: string } | null) => ({
    data: { data: params?.id ? [{ id: params.id, fileName: 'Deep Book', tags: [] }] : [] },
    isLoading: false,
  }),
  // Page mode renders DataLakeArticle, which reads file content.
  useGetFabFileContent: () => ({ data: null, isLoading: false }),
}));

vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));

// The page-mode header's ManageKnowledgeButton folds in the EnableDataLakes gate, which
// reaches the admin settings cache; mirror manageKnowledge.test's stubs for that chain.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => true, isFeatureEnabled: () => true, isLoading: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { isAdmin: boolean }) => unknown) =>
    selector ? selector({ isAdmin: true }) : { isAdmin: true },
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: () => void }) => unknown) =>
    selector({ openManager: vi.fn() }),
}));

// Collapsed-sidenav clearance reads this store; default open (no extra indent) for these tests.
vi.mock('@client/app/components/layouts/Notebook', () => ({
  useNotebookLayout: (sel: (s: { openSideNav: boolean }) => unknown) => sel({ openSideNav: true }),
}));

// The explorer calls useSetDataLakeMode at render (for the tree close button); its persist
// logic is covered in useSetDataLakeMode.test. Spy so the close-wiring test below can assert
// without needing a QueryClient.
const { setModeSpy, toastInfo, toastError } = vi.hoisted(() => ({
  setModeSpy: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/hooks/useSetDataLakeMode', () => ({ default: () => setModeSpy }));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError } }));

// Stub the tree so we can trigger onSelectFile/onClose deterministically and read the
// highlight prop. Chat mode (chatSlot set) renders DataLakeChatTree, so that is what we stub.
vi.mock('./DataLakeChatTree', () => ({
  default: ({
    onSelectFile,
    selectedFileId,
    onClose,
  }: {
    onSelectFile: (f: { id: string; fileName: string }) => void;
    selectedFileId: string | null;
    onClose?: () => void;
  }) => (
    <div data-testid="mock-tree" data-selected={selectedFileId ?? ''}>
      <button data-testid="mock-select-file" onClick={() => onSelectFile({ id: 'file-123', fileName: 'x.pdf' })}>
        select
      </button>
      {/* Mirror the real header: the close X renders only when an onClose is supplied. */}
      {onClose && (
        <button data-testid="mock-close" onClick={onClose}>
          close
        </button>
      )}
    </div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Main-app arrangement (DataLakeChatSurface): the chat is embedded in the right pane, so file
// clicks own the layout. Overlay-host tests override chatEmbedded per-case.
const baseProps = {
  source: 'datalakes' as const,
  chatSlot: <div data-testid="my-chat" />,
  chatEmbedded: true,
};

const renderExplorer = (props: Partial<React.ComponentProps<typeof DataLakeExplorer>> = {}) =>
  render(
    <TestWrapper>
      <DataLakeExplorer {...baseProps} {...props} />
    </TestWrapper>
  );

describe('DataLakeExplorer chat-first surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.currentSessionId = 'sess-1';
  });

  it('renders chatSlot in the right pane', () => {
    renderExplorer();
    expect(screen.getByTestId('my-chat')).toBeInTheDocument();
  });

  it('opens a clicked file inline (workbench + vertical KnowledgeViewer) in chat mode', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-select-file'));
    // Added to the session workbench so the KnowledgeViewer renders it.
    expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
    // Layout switched to the split view with the file selected.
    expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'file-123' });
    // The clicked file is highlighted in the tree.
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
  });

  it('opens the deep-linked articleId inline once it resolves', () => {
    renderExplorer({ articleId: 'deep-1' });
    expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'deep-1' });
  });

  it('without chatEmbedded (overlay host, chat docked outside): file click adds to the workbench + toasts, never touches layout', () => {
    // Regression guard: switching to 'vertical' here collapsed the overlay's docked chat into
    // the 0x0 non-docked branch with no on-surface way back. The contract is keyed on the HOST
    // prop, not the live layout store - that store is global and leaks across surfaces.
    renderExplorer({ chatEmbedded: false });
    fireEvent.click(screen.getByTestId('mock-select-file'));
    expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(toastInfo).toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
    // The clicked file still highlights in the tree.
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
  });

  it('tree close (X) turns Data Lake mode off via the shared setter', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-close'));
    expect(setModeSpy).toHaveBeenCalledWith(false);
  });

  it('showModeClose={false} hides the close X (nav-managed hosts keep only the info icon)', () => {
    renderExplorer({ showModeClose: false });
    expect(screen.queryByTestId('mock-close')).toBeNull();
  });

  it('no session + no createSessionForFile (overlay): file click guides via toast, writes nothing', () => {
    // The viewer reads the session workbench, so with no session it would render empty and
    // auto-hide (reads as a dead click); hosts without a create path get guidance instead.
    sessionState.currentSessionId = null;
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-select-file'));
    expect(toastInfo).toHaveBeenCalled();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
    // The pick still highlights so the guidance has a visible anchor.
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
  });

  it('no session + createSessionForFile (main app /new): mints the session, then opens the file in the viewer', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockResolvedValue('sess-new');
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-select-file'));
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-new', expect.any(Function));
      expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'file-123' });
    });
    expect(createSessionForFile).toHaveBeenCalledTimes(1);
  });

  it('no session + createSessionForFile rejection: toasts an error and opens nothing', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-select-file'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// Page mode (no chatSlot) is the only arrangement that renders the header action row.
const renderPageExplorer = (props: Partial<React.ComponentProps<typeof DataLakeExplorer>> = {}) =>
  render(
    <TestWrapper>
      <DataLakeExplorer source="datalakes" onBack={vi.fn()} {...props} />
    </TestWrapper>
  );

describe('DataLakeExplorer - Create primary alongside Manage secondary', () => {
  it('renders both buttons, Create first, each wired to its own handler', () => {
    const onCreate = vi.fn();
    const onManage = vi.fn();
    renderPageExplorer({ onCreate, onManage });

    const createBtn = screen.getByTestId('datalake-create-btn');
    const manageBtn = screen.getByTestId('datalake-manage-btn');
    expect(createBtn.compareDocumentPosition(manageBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(createBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();

    fireEvent.click(manageBtn);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('gives Create the primary treatment and Manage the secondary one', () => {
    renderPageExplorer({ onCreate: vi.fn(), onManage: vi.fn() });

    // Joy's variant/color modifier classes are a stable public API (unlike its emotion
    // hashes), so they are the only way to assert visual hierarchy without a snapshot.
    const createBtn = screen.getByTestId('datalake-create-btn');
    expect(createBtn.className).toMatch(/MuiButton-variantSolid/);
    expect(createBtn.className).toMatch(/MuiButton-colorPrimary/);

    const manageBtn = screen.getByTestId('datalake-manage-btn');
    expect(manageBtn.className).toMatch(/MuiButton-variantOutlined/);
    expect(manageBtn.className).toMatch(/MuiButton-colorNeutral/);
  });
});
