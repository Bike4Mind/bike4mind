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

  it('shows the non-owner copy - states only certain post-removal reach, still promises Undo', () => {
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
});
