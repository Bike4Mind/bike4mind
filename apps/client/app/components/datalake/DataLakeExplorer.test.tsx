import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// KnowledgeModal store: spy on the setters so we can assert file clicks / deep-links drive it.
// Mocked (rather than importing the real store) to avoid dragging in the heavy modal deps.
const { setOpen, setSelectedFabFileId, setViewOnly } = vi.hoisted(() => ({
  setOpen: vi.fn(),
  setSelectedFabFileId: vi.fn(),
  setViewOnly: vi.fn(),
}));
vi.mock('@client/app/components/Knowledge/KnowledgeModal', () => ({
  useKnowledgeModal: (selector: (s: unknown) => unknown) =>
    selector({ open: false, selectedFabFileId: null, viewOnly: false, setOpen, setSelectedFabFileId, setViewOnly }),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({
    data: { tagCounts: [], uniqueArticleCounts: { total: 0 } },
    isLoading: false,
    isError: false,
  }),
  useGetDataLakeArticles: () => ({ data: { data: [] }, isLoading: false }),
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
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
  onBack: vi.fn(),
  onAskAbout: vi.fn(),
  source: 'datalakes' as const,
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

  it('renders chatSlot in the right pane and hides the markdown article', () => {
    renderExplorer({ chatSlot: <div data-testid="my-chat" /> });
    expect(screen.getByTestId('my-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-article')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-article-empty')).not.toBeInTheDocument();
  });

  it('opens the rich KnowledgeModal (read-only) when a file is clicked in chat mode', () => {
    renderExplorer({ chatSlot: <div data-testid="my-chat" /> });
    fireEvent.click(screen.getByTestId('mock-select-file'));
    expect(setSelectedFabFileId).toHaveBeenCalledWith('file-123');
    expect(setViewOnly).toHaveBeenCalledWith(true);
    expect(setOpen).toHaveBeenCalledWith(true);
    // The clicked file is highlighted in the tree.
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
  });

  it('opens the KnowledgeModal for the deep-linked articleId on mount in chat mode', () => {
    renderExplorer({ chatSlot: <div data-testid="my-chat" />, articleId: 'deep-1' });
    expect(setSelectedFabFileId).toHaveBeenCalledWith('deep-1');
    expect(setViewOnly).toHaveBeenCalledWith(true);
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it('back-compat: with no chatSlot, renders DataLakeArticle and does NOT open the modal on click', () => {
    renderExplorer();
    // Empty-state article is shown (no file selected yet), not a chat.
    expect(screen.getByTestId('datalake-article-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-select-file'));
    // Legacy path selects into the article panel; the modal is never opened.
    expect(setOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('datalake-article')).toBeInTheDocument();
  });
});
