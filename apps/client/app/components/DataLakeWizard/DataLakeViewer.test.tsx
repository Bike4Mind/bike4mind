import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CHUNK_STALL_NOTICES, NO_EXTRACTABLE_TEXT_NOTICE, type IFabFileDocument } from '@bike4mind/common';
import DataLakeViewer from './DataLakeViewer';

const useDataLakeFiles = vi.fn();
const useGetFabFileContent = vi.fn();

const mutationStub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
vi.mock('@client/app/hooks/data/dataLakes', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/dataLakes')>()),
  useDataLakeFiles: (...args: unknown[]) => useDataLakeFiles(...args),
  useGetDataLakeArticles: () => ({ data: undefined, isLoading: false }),
  useReprocessFabFile: () => mutationStub(),
  useRemoveFileFromDataLake: () => mutationStub(),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: (...args: unknown[]) => useGetFabFileContent(...args),
}));

vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content?: string }) => <div data-testid="mock-markdown">{content}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// No prefix-matching tag, so the file lands in the tree's "Uncategorized" bucket and is one click away.
const fabFile = (overrides: Partial<IFabFileDocument> = {}) =>
  ({
    id: 'ff1',
    fileName: 'quarterly.pdf',
    tags: [],
    ...overrides,
  }) as unknown as IFabFileDocument;

const openFile = async (file: IFabFileDocument) => {
  useDataLakeFiles.mockReturnValue({ data: { data: [file] }, isLoading: false, isError: false });
  render(
    <TestWrapper>
      <DataLakeViewer dataLakeId="lk1" dataLakeName="Sales" tagPrefix="sales:" />
    </TestWrapper>
  );
  await userEvent.click(screen.getByTestId('datalake-node-uncategorized'));
  await userEvent.click(screen.getByTestId(`datalake-file-${file.id}`));
};

describe('DataLakeViewer pipeline notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGetFabFileContent.mockReturnValue({ data: 'body', isLoading: false });
  });

  it('renders the stall notice and the owner note as two separate lines', async () => {
    await openFile(fabFile({ chunkStallReason: 'vectorizePaused', notes: 'Ask legal before sharing' }));

    const notice = screen.getByText(CHUNK_STALL_NOTICES.vectorizePaused, { exact: false });
    const ownerNote = screen.getByText('Ask legal before sharing');
    expect(notice).not.toBe(ownerNote);
    expect(notice.compareDocumentPosition(ownerNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the zero-chunk notice from noExtractableTextAt', async () => {
    await openFile(fabFile({ noExtractableTextAt: new Date('2026-08-01T00:00:00Z') }));

    expect(screen.getByText(NO_EXTRACTABLE_TEXT_NOTICE, { exact: false })).toBeTruthy();
  });

  it('renders the owner note alone when the pipeline has nothing to say', async () => {
    await openFile(fabFile({ notes: 'Ask legal before sharing' }));

    expect(screen.getByText('Ask legal before sharing')).toBeTruthy();
    expect(screen.queryByText(CHUNK_STALL_NOTICES.vectorizePaused, { exact: false })).toBeNull();
    expect(screen.queryByText(NO_EXTRACTABLE_TEXT_NOTICE, { exact: false })).toBeNull();
  });
});
