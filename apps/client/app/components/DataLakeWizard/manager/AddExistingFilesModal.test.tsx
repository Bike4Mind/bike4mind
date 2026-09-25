import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IFabFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import AddExistingFilesModal, { partitionLakeAddCandidates } from './AddExistingFilesModal';
import type { ManagerLake } from './shared';

// A row's click reaches GenericAddItemsModal's toggle wrapper, so these tests drive the real
// selection plumbing rather than calling the component's own handlers.
const h = vi.hoisted(() => ({
  addFilesToLake: vi.fn(() => Promise.resolve(undefined)),
  files: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useAddFilesToLake: () => ({ mutateAsync: h.addFilesToLake, isPending: false }),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFiles: (...args: unknown[]) => h.files(...args),
}));

// GetFileIcon pulls image-moderation and preview machinery that is irrelevant here.
vi.mock('@client/app/utils/fabFileUtils', () => ({
  GetFileIcon: () => <span data-testid="mock-file-icon" />,
}));

const memberFile = { id: 'f-member', fileName: 'already.md', tags: [{ name: 'datalake:mine' }] };
const nonMemberFile = { id: 'f-new', fileName: 'fresh.md', tags: [{ name: 'genre:war' }] };

const lake = {
  id: 'mine',
  name: 'Mine',
  slug: 'mine',
  fileTagPrefix: 'lk',
  datalakeTag: 'datalake:mine',
  status: 'active',
  canManage: true,
  isOwn: true,
} as unknown as ManagerLake;

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = (overrides: Partial<ManagerLake> = {}, onClose = vi.fn()) => {
  const props = { ...lake, ...overrides } as ManagerLake;
  render(
    <Wrapper>
      <AddExistingFilesModal lake={props} open onClose={onClose} />
    </Wrapper>
  );
  return { onClose };
};

beforeEach(() => {
  h.addFilesToLake.mockClear();
  h.files.mockReset();
  h.files.mockReturnValue({
    data: { pages: [{ data: [memberFile, nonMemberFile] }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  });
});

describe('partitionLakeAddCandidates', () => {
  it('routes members to the skipped list and never to the add list', () => {
    const { addIds, memberIds } = partitionLakeAddCandidates(
      [memberFile, nonMemberFile] as unknown as IFabFileDocument[],
      ['f-member', 'f-new'],
      'datalake:mine'
    );
    expect(addIds).toEqual(['f-new']);
    expect(memberIds).toEqual(['f-member']);
  });

  it('drops ids with no loaded file rather than forwarding them unchecked', () => {
    const { addIds, memberIds } = partitionLakeAddCandidates(
      [nonMemberFile] as unknown as IFabFileDocument[],
      ['f-new', 'f-vanished'],
      'datalake:mine'
    );
    expect(addIds).toEqual(['f-new']);
    expect(memberIds).toEqual([]);
  });
});

describe('AddExistingFilesModal', () => {
  it('lists own files and marks an existing member disabled with a chip', () => {
    renderModal();

    expect(screen.getByTestId('datalake-addexisting-item-f-member')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-addexisting-item-f-new')).toBeInTheDocument();
    // Joy renders the disabled state as a class on the checkbox root rather than the attribute.
    expect(screen.getByTestId('datalake-addexisting-checkbox-f-member')).toHaveClass('Mui-disabled');
    expect(screen.getByTestId('datalake-addexisting-member-chip-f-member')).toHaveTextContent('Already in lake');
    expect(screen.queryByTestId('datalake-addexisting-member-chip-f-new')).toBeNull();
  });

  it('never sends an existing member to the add request, even when its row is clicked', async () => {
    const user = userEvent.setup();
    renderModal();

    // The member row is inert: clicking it must not put the file into the selection.
    await user.click(screen.getByTestId('datalake-addexisting-item-f-member'));
    await user.click(screen.getByTestId('datalake-addexisting-item-f-new'));
    await user.click(screen.getByTestId('generic-add-items-submit-btn'));

    expect(h.addFilesToLake).toHaveBeenCalledTimes(1);
    expect(h.addFilesToLake).toHaveBeenCalledWith({
      fileIds: ['f-new'],
      lake: { id: 'mine', datalakeTag: 'datalake:mine' },
      skippedCount: 0,
    });
  });

  it('cannot be submitted while only an existing member is selected', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-member'));

    expect(screen.getByTestId('generic-add-items-submit-btn')).toBeDisabled();
    expect(h.addFilesToLake).not.toHaveBeenCalled();
  });

  it('shows the draft notice on a draft lake', () => {
    renderModal({ status: 'draft' });
    expect(screen.getByText(/This lake is a draft/)).toBeInTheDocument();
  });

  it('shows the draft notice when the status is absent', () => {
    renderModal({ status: undefined });
    expect(screen.getByText(/This lake is a draft/)).toBeInTheDocument();
  });

  it('hides the draft notice on an active lake', () => {
    renderModal();
    expect(screen.queryByText(/This lake is a draft/)).toBeNull();
  });
});
