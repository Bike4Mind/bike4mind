import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// Chat-first mode opens a clicked file INLINE in the KnowledgeViewer by adding it to the
// session workbench and switching layout to `vertical`. Spy on those two seams.
const { setWorkBenchFiles, setSessionLayout } = vi.hoisted(() => ({
  setWorkBenchFiles: vi.fn(),
  setSessionLayout: vi.fn(),
}));
vi.mock('@client/app/contexts/SessionsContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/SessionsContext')>()),
  useSessions: () => ({ currentSessionId: 'sess-1' }),
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
}));

vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));

// Stub the tree so we can trigger onSelectFile deterministically and read the highlight prop.
vi.mock('./DataLakeTree', () => ({
  default: ({
    onSelectFile,
    selectedFileId,
  }: {
    onSelectFile: (f: { id: string; fileName: string }) => void;
    selectedFileId: string | null;
  }) => (
    <div data-testid="mock-tree" data-selected={selectedFileId ?? ''}>
      <button data-testid="mock-select-file" onClick={() => onSelectFile({ id: 'file-123', fileName: 'x.pdf' })}>
        select
      </button>
    </div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  source: 'datalakes' as const,
  chatSlot: <div data-testid="my-chat" />,
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
});
