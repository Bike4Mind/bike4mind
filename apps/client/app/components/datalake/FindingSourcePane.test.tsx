import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeFindingSource } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  file: vi.fn(),
  content: vi.fn(),
  markdown: vi.fn(),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFile: (id: string | null) => h.file(id),
  useGetFabFileContent: (file: unknown) => h.content(file),
}));

// Stands in for the #3038 chunk renderer so the pane's contract with it - the passage is handed
// over as `citedPassage`, in the whole document - is asserted rather than assumed.
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: (props: { content: string; citedPassage?: string }) => {
    h.markdown(props);
    return <div data-testid="markdown-viewer">{props.content}</div>;
  },
  UnmarkedCitedPassage: ({ passage }: { passage: string }) => <div data-testid="unmarked-passage">{passage}</div>,
}));

import FindingSourcePane from './FindingSourcePane';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const source: LakeFindingSource = {
  fabFileId: 'file-a',
  fileName: 'investor-update.md',
  excerpt: 'ARR reached $4.2M in Q1.',
};

const renderPane = (over: Partial<LakeFindingSource> = {}) =>
  render(
    <TestWrapper>
      <FindingSourcePane source={{ ...source, ...over }} />
    </TestWrapper>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.file.mockReturnValue({ data: { id: 'file-a', fileName: 'investor-update.md' }, isLoading: false, isError: false });
  h.content.mockReturnValue({ data: '# Update\n\nARR reached $4.2M in Q1.', isLoading: false, isError: false });
});

describe('FindingSourcePane', () => {
  it('renders the whole document with the quoted passage handed to the chunk renderer', () => {
    renderPane();

    expect(screen.getByTestId('markdown-viewer')).toHaveTextContent('ARR reached $4.2M in Q1.');
    expect(h.markdown).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Update\n\nARR reached $4.2M in Q1.', citedPassage: source.excerpt })
    );
  });

  it('names the document and cites it with a deep link a curator can open', () => {
    renderPane();

    expect(screen.getByTestId('finding-source-title')).toHaveTextContent('investor-update.md');
    expect(screen.getByTestId('finding-source-citation')).toHaveAttribute('href', '/data-lakes?article=file-a');
  });

  // The finding's own name is what the detector saw, so it survives a file read that came back
  // empty - a pane titled "Untitled document" tells a curator nothing about which side this is.
  it('falls back to the detected name when the document cannot be read', () => {
    h.file.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    h.content.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPane();

    expect(screen.getByTestId('finding-source-title')).toHaveTextContent('investor-update.md');
  });

  it('still shows the quoted passage when the document is gone', () => {
    h.file.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    h.content.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPane();

    expect(screen.getByTestId('finding-source-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('unmarked-passage')).toHaveTextContent('ARR reached $4.2M in Q1.');
  });

  // "No readable text" is a claim about the corpus a curator may act on, so a failed fetch of a
  // perfectly readable document must never be reported as one.
  it('tells a failed content read apart from an empty document', () => {
    h.content.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderPane();

    expect(screen.getByTestId('finding-source-unavailable')).toHaveTextContent(/could not be loaded/i);
    expect(screen.getByTestId('finding-source-unavailable')).not.toHaveTextContent(/no readable text/i);
  });

  it('reports an empty document as having no readable text', () => {
    h.content.mockReturnValue({ data: '', isLoading: false, isError: false });
    renderPane();

    expect(screen.getByTestId('finding-source-unavailable')).toHaveTextContent(/no readable text/i);
  });

  it('shows a placeholder while the document loads', () => {
    h.content.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderPane();

    expect(screen.queryByTestId('markdown-viewer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finding-source-unavailable')).not.toBeInTheDocument();
  });
});
