import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeArticlePanel from './DataLakeArticlePanel';

const { removeFileMutate, currentUserId } = vi.hoisted(() => ({
  removeFileMutate: vi.fn(),
  currentUserId: { value: 'owner-1' },
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => ({ data: 'content', isLoading: false }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useReprocessFabFile: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFileFromDataLake: () => ({ mutate: removeFileMutate, isPending: false }),
  usePurgeDataLakeDocument: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { currentUser: { id: string } }) => unknown) =>
    selector ? selector({ currentUser: { id: currentUserId.value } }) : { currentUser: { id: currentUserId.value } },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const file = (overrides: Partial<IFabFileDocument> = {}): IFabFileDocument =>
  ({
    id: 'f1',
    fileName: 'Report.pdf',
    userId: 'owner-1',
    tags: [{ name: 'lk:invoices', strength: 1 }],
    ...overrides,
  }) as IFabFileDocument;

describe('DataLakeArticlePanel - remove-from-lake copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserId.value = 'owner-1';
  });

  const openConfirm = () => fireEvent.click(screen.getByTestId('datalake-removefile-btn-f1'));

  it('shows the owner copy - stays in Files, restorable with Undo', () => {
    render(
      <TestWrapper>
        <DataLakeArticlePanel file={file({ userId: 'owner-1' })} dataLakeId="lake1" lakeName="Lake" canManage />
      </TestWrapper>
    );

    openConfirm();

    const text = screen.getByTestId('datalake-removefile-confirm').textContent ?? '';
    expect(text).toMatch(/stays in your Files list/);
    expect(text).toMatch(/Undo/);
  });

  it('shows the non-owner copy - only certain post-removal reach, and a TIME-BOUNDED Undo', () => {
    currentUserId.value = 'curator-1';
    render(
      <TestWrapper>
        <DataLakeArticlePanel file={file({ userId: 'owner-1' })} dataLakeId="lake1" lakeName="Lake" canManage />
      </TestWrapper>
    );

    openConfirm();

    const text = screen.getByTestId('datalake-removefile-confirm').textContent ?? '';
    expect(text).not.toMatch(/your Files list/);
    expect(text).toMatch(/owner's Files list/);
    expect(text).toMatch(/lose access/);
    expect(text).toMatch(/Undo/);
    // A non-owner has NO other way back - no list route, no "recently removed" panel - so the copy
    // must not promise recoverability open-endedly the way the owner branch fairly can. Promising
    // an Undo that silently expires is the same defect #2248 was filed about, one layer in.
    expect(text).toMatch(/gone once the toast closes/);
    expect(text).not.toMatch(/re-adding it to this lake/);
  });

  it('fires the removal mutation on confirm', () => {
    render(
      <TestWrapper>
        <DataLakeArticlePanel file={file()} dataLakeId="lake1" lakeName="Lake" canManage />
      </TestWrapper>
    );

    openConfirm();
    fireEvent.click(screen.getByTestId('datalake-removefile-confirm-btn'));

    expect(removeFileMutate).toHaveBeenCalledWith('f1', expect.anything());
  });

  it('hides the management actions when the caller cannot manage the lake', () => {
    render(
      <TestWrapper>
        <DataLakeArticlePanel file={file()} dataLakeId="lake1" lakeName="Lake" canManage={false} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-removefile-btn-f1')).not.toBeInTheDocument();
  });

  it('renders the permanent-deletion door only for a caller who may use it', () => {
    // The render gate is the outer half of the two-part rule the service enforces: without it a
    // curator, or a lake owner looking at someone else's document, meets a red "Delete permanently"
    // that 400s only after they have confirmed it.
    const { rerender } = render(
      <TestWrapper>
        <DataLakeArticlePanel file={file()} dataLakeId="lake1" lakeName="Lake" canManage canPurge={false} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('datalake-purgefile-btn-f1')).not.toBeInTheDocument();

    rerender(
      <TestWrapper>
        <DataLakeArticlePanel file={file()} dataLakeId="lake1" lakeName="Lake" canManage canPurge />
      </TestWrapper>
    );
    expect(screen.getByTestId('datalake-purgefile-btn-f1')).toBeInTheDocument();
  });
});
