import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// Browsing the tree must never mutate the chat: attach happens only via the explicit [+]
// action, and nothing may touch the session layout. setSessionLayout is spied purely as a
// regression guard - the suite asserts it is never called.
const { setWorkBenchFiles, setSessionLayout, sessionState, removeFileMutate, lakesState } = vi.hoisted(() => ({
  setWorkBenchFiles: vi.fn(),
  setSessionLayout: vi.fn(),
  // Mutable so the /new (deferred creation, no session yet) case can null it per-test.
  sessionState: { currentSessionId: 'sess-1' as string | null },
  removeFileMutate: vi.fn(),
  // Mutable so delete-gating tests can vary the accessible-lake list per-test.
  lakesState: {
    value: [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: true }] as unknown[],
  },
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

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  activeOrgId: () => undefined,
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
  useGetDataLakes: () => ({ data: lakesState.value }),
  useRemoveFileFromDataLake: () => ({ mutate: removeFileMutate, isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  // Page mode renders DataLakeArticle, which reads the selected file's body.
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));

// The rail viewer mounts KnowledgeViewer, which pulls in the websocket/session/artifact chain.
// What this suite owns is the explorer's wiring - whether the rail swaps and Back returns - so
// the wrapper is stubbed with the same test ids it renders.
vi.mock('./DataLakeRailViewer', () => ({
  default: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="datalake-rail-viewer">
      <button data-testid="datalake-viewer-back-btn" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));

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
  useDataLakeWizardStore: (selector: (s: { openManager: () => void }) => unknown) => selector({ openManager: vi.fn() }),
}));

// Collapsed-sidenav clearance reads this store; default open (no extra indent) for these tests.
vi.mock('@client/app/components/layouts/Notebook', () => ({
  useNotebookLayout: (sel: (s: { openSideNav: boolean }) => unknown) => sel({ openSideNav: true }),
}));

// The explorer calls useSetDataLakeMode at render (for the tree close button); its persist
// logic is covered in useSetDataLakeMode.test. Spy so the close-wiring test below can assert
// without needing a QueryClient.
const { setModeSpy, toastInfo, toastError, toastSuccess } = vi.hoisted(() => ({
  setModeSpy: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@client/app/hooks/useSetDataLakeMode', () => ({ default: () => setModeSpy }));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError, success: toastSuccess } }));

// Stub the tree so we can trigger the row actions deterministically and read the highlight
// prop. Chat mode (chatSlot set) renders DataLakeChatTree, so that is what we stub. The file
// carries a membership meta-tag so delete-gating tests exercise resolveManageableLake for real.
vi.mock('./DataLakeChatTree', () => ({
  default: (props: {
    onAttachFile: (f: { id: string; fileName: string }) => void;
    onViewFile: (f: { id: string; fileName: string }) => void;
    canDeleteFile: (f: { id: string; fileName: string }) => boolean;
    onDeleteFile: (f: { id: string; fileName: string }) => void;
    selectedFileId: string | null;
    onClose?: () => void;
  }) => {
    const file = { id: 'file-123', fileName: 'x.pdf', tags: [{ name: 'datalake:lake-a' }] };
    return (
      <div
        data-testid="mock-tree"
        data-selected={props.selectedFileId ?? ''}
        data-can-delete={String(props.canDeleteFile(file))}
      >
        <button data-testid="mock-attach" onClick={() => props.onAttachFile(file)}>
          attach
        </button>
        <button data-testid="mock-view" onClick={() => props.onViewFile(file)}>
          view
        </button>
        <button data-testid="mock-delete" onClick={() => props.onDeleteFile(file)}>
          delete
        </button>
        {props.onClose && (
          <button data-testid="mock-close" onClick={props.onClose}>
            close
          </button>
        )}
      </div>
    );
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Main-app arrangement (DataLakeChatSurface): the chat fills the right pane, so View may drive
// the KnowledgeViewer split. Row actions are the only way browsing reaches the chat (no
// click-to-open). Overlay-host tests override chatEmbedded per-case.
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
    lakesState.value = [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: true }];
  });

  it('renders chatSlot in the right pane', () => {
    renderExplorer();
    expect(screen.getByTestId('my-chat')).toBeInTheDocument();
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

  it('touches neither the workbench nor the layout until an action runs', () => {
    // Browsing (mounting, navigating) stays inert; only the row actions below reach the chat.
    // Which gesture triggers which action is the tree's contract - see DataLakeChatTree.test.
    renderExplorer();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('attach action adds the file to the workbench and toasts, never touching layout', async () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-attach'));
    await vi.waitFor(() => expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function)));
    expect(toastSuccess).toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('attach on /new with createSessionForFile mints the session, then attaches', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockResolvedValue('sess-new');
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-attach'));
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-new', expect.any(Function));
    });
    expect(createSessionForFile).toHaveBeenCalledTimes(1);
  });

  it('attach with no session and no create path guides via toast, writes nothing', () => {
    sessionState.currentSessionId = null;
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-attach'));
    expect(toastInfo).toHaveBeenCalled();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
  });

  it('attach create rejection toasts an error and attaches nothing', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-attach'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('view opens the KnowledgeViewer split on the embedded host', async () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-view'));
    // The viewer builds its tabs from the workbench, so the file must land there to have a tab.
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
      expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'file-123' });
    });
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
    // The rail keeps the tree; the chat's own SessionContainer renders the viewer here.
    expect(screen.queryByTestId('datalake-rail-viewer')).toBeNull();
  });

  it('view on /new mints the session first, then opens the split', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockResolvedValue('sess-new');
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-view'));
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-new', expect.any(Function));
      expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'file-123' });
    });
    expect(createSessionForFile).toHaveBeenCalledTimes(1);
  });

  it('view on an overlay host mounts the viewer in the rail and never sets a layout', async () => {
    // Regression guard: switching to 'vertical' here collapsed the overlay's docked chat into
    // the 0x0 non-docked branch with no on-surface way back. Keyed on the HOST prop, not the
    // live layout store - that store is global and leaks across surfaces. Selecting the artifact
    // is fine; it is `layout` that must never be written.
    renderExplorer({ chatEmbedded: false });
    fireEvent.click(screen.getByTestId('mock-view'));
    await vi.waitFor(() => expect(screen.getByTestId('datalake-rail-viewer')).toBeInTheDocument());
    // Beside the tree, not instead of it - browsing on to the next file must stay possible.
    expect(screen.getByTestId('mock-tree')).toBeInTheDocument();
    expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(setSessionLayout).toHaveBeenCalledWith({ selectedArtifactId: 'file-123' });
    expect(setSessionLayout).not.toHaveBeenCalledWith(
      expect.objectContaining({ layout: expect.anything() as unknown as string })
    );
  });

  it('viewer back closes it and leaves the viewed file highlighted (overlay host)', async () => {
    renderExplorer({ chatEmbedded: false });
    fireEvent.click(screen.getByTestId('mock-view'));
    await vi.waitFor(() => expect(screen.getByTestId('datalake-viewer-back-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('datalake-viewer-back-btn'));
    expect(screen.queryByTestId('datalake-rail-viewer')).toBeNull();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
  });

  it('deep-linked articleId opens it the same way View does', async () => {
    renderExplorer({ articleId: 'deep-1' });
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
      expect(setSessionLayout).toHaveBeenCalledWith({ layout: 'vertical', selectedArtifactId: 'deep-1' });
    });
  });

  it('delete is offered only for a uniquely-resolved manageable lake', () => {
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-can-delete', 'true');
  });

  it('delete is not offered when the owning lake is not manageable', () => {
    lakesState.value = [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: false }];
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-can-delete', 'false');
  });

  it('delete action confirms first, then fires the per-lake removal', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-delete'));
    expect(removeFileMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('datalake-tree-removefile-confirm-btn'));
    expect(removeFileMutate).toHaveBeenCalledWith('file-123', expect.anything());
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

describe('DataLakeExplorer - drag-and-drop discoverability (#839)', () => {
  it('advertises drag-to-add at rest, before any drag has started', () => {
    render(
      <TestWrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </TestWrapper>
    );

    // No drag is underway, so the drag-active overlay must stay hidden while the
    // resting affordances carry the invitation.
    expect(screen.queryByTestId('datalake-dropzone')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-drop-hint')).toHaveTextContent(/drag files here to add/i);
    expect(screen.getByTestId('datalake-drop-prompt')).toBeInTheDocument();
  });

  it('swaps the resting hint for the drag overlay once a file drag enters', () => {
    render(
      <TestWrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </TestWrapper>
    );

    fireEvent.dragEnter(screen.getByTestId('datalake-explorer'), {
      dataTransfer: { types: ['Files'] },
    });

    expect(screen.getByTestId('datalake-dropzone')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-drop-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-drop-prompt')).not.toBeInTheDocument();
  });

  it('confirms a successful drop with a toast naming the file count', async () => {
    render(
      <TestWrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </TestWrapper>
    );

    fireEvent.drop(screen.getByTestId('datalake-explorer'), {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      },
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^2 files /)));
  });
});
