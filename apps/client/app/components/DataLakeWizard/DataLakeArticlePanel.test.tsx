import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CHUNK_STALL_NOTICES, NO_EXTRACTABLE_TEXT_NOTICE, type IFabFileDocument } from '@bike4mind/common';
import DataLakeArticlePanel from './DataLakeArticlePanel';

const useGetFabFileContent = vi.fn();
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: (...args: unknown[]) => useGetFabFileContent(...args),
}));

const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useReprocessFabFile: () => mutationStub(),
  useRemoveFileFromDataLake: () => mutationStub(),
}));

vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content?: string }) => <div data-testid="mock-markdown">{content}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Only the fields the panel's header reads; the pipeline fields are what these cases vary.
const fabFile = (overrides: Partial<IFabFileDocument> = {}) =>
  ({
    id: 'ff1',
    fileName: 'quarterly.pdf',
    tags: [],
    ...overrides,
  }) as unknown as IFabFileDocument;

const renderPanel = (file: IFabFileDocument) =>
  render(
    <TestWrapper>
      <DataLakeArticlePanel file={file} dataLakeId="lk1" />
    </TestWrapper>
  );

describe('DataLakeArticlePanel pipeline notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGetFabFileContent.mockReturnValue({ data: 'body', isLoading: false });
  });

  it('renders the stall notice and the owner note as two separate lines', () => {
    renderPanel(fabFile({ chunkStallReason: 'vectorizePaused', notes: 'Ask legal before sharing' }));

    const notice = screen.getByText(CHUNK_STALL_NOTICES.vectorizePaused, { exact: false });
    const ownerNote = screen.getByText('Ask legal before sharing');
    expect(notice).toBeTruthy();
    expect(ownerNote).toBeTruthy();
    // The regression this PR exists to prevent: one field doing both jobs. Distinct elements, and
    // the pipeline line comes first.
    expect(notice).not.toBe(ownerNote);
    expect(notice.compareDocumentPosition(ownerNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the zero-chunk notice from noExtractableTextAt', () => {
    renderPanel(fabFile({ noExtractableTextAt: new Date('2026-08-01T00:00:00Z') }));

    expect(screen.getByText(NO_EXTRACTABLE_TEXT_NOTICE, { exact: false })).toBeTruthy();
  });

  it('renders the owner note alone when the pipeline has nothing to say', () => {
    renderPanel(fabFile({ notes: 'Ask legal before sharing' }));

    expect(screen.getByText('Ask legal before sharing')).toBeTruthy();
    expect(screen.queryByText(CHUNK_STALL_NOTICES.vectorizePaused, { exact: false })).toBeNull();
    expect(screen.queryByText(NO_EXTRACTABLE_TEXT_NOTICE, { exact: false })).toBeNull();
  });

  it('renders the stall notice with no owner note present', () => {
    renderPanel(fabFile({ chunkStallReason: 'rechunkPaused' }));

    expect(screen.getByText(CHUNK_STALL_NOTICES.rechunkPaused, { exact: false })).toBeTruthy();
  });
});
