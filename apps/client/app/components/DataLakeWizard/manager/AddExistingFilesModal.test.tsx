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
  addFilesToLake: vi.fn(),
  files: vi.fn(),
  isMutating: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useAddFilesToLake: () => ({ mutate: h.addFilesToLake, isPending: false }),
  addFilesToLakeMutationKey: ['addFilesToLake'],
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFiles: (...args: unknown[]) => h.files(...args),
}));

// Real useIsMutating needs a QueryClientProvider this suite does not set up (every other
// react-query-backed hook here is mocked too); stub it so addInFlight is test-controlled.
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useIsMutating: (...args: unknown[]) => h.isMutating(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: h.toastInfo, error: h.toastError },
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
  const utils = render(
    <Wrapper>
      <AddExistingFilesModal lake={props} open onClose={onClose} />
    </Wrapper>
  );
  return { onClose, props, ...utils };
};

beforeEach(() => {
  h.addFilesToLake.mockClear();
  h.toastInfo.mockClear();
  h.toastError.mockClear();
  h.files.mockReset();
  h.files.mockReturnValue({
    data: { pages: [{ data: [memberFile, nonMemberFile] }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetching: false,
  });
  h.isMutating.mockReset();
  h.isMutating.mockReturnValue(0);
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

  it('keeps a selection made under an earlier search', async () => {
    const user = userEvent.setup();
    const fileA = { id: 'f-a', fileName: 'report.md', tags: [] };
    const fileB = { id: 'f-b', fileName: 'invoice.md', tags: [] };
    // Page results keyed on the search term, as the real hook is.
    h.files.mockImplementation((search?: string) => ({
      data: { pages: [{ data: search === 'report' ? [fileA] : search === 'invoice' ? [fileB] : [] }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: false,
    }));
    renderModal();

    const search = screen.getByTestId('generic-add-items-search-input').querySelector('input')!;
    await user.type(search, 'report');
    await screen.findByTestId('datalake-addexisting-item-f-a');
    await user.click(screen.getByTestId('datalake-addexisting-item-f-a'));

    await user.clear(search);
    await user.type(search, 'invoice');
    await screen.findByTestId('datalake-addexisting-item-f-b');
    // A is off the current page but must stay selected.
    expect(screen.queryByTestId('datalake-addexisting-item-f-a')).toBeNull();
    await user.click(screen.getByTestId('datalake-addexisting-item-f-b'));

    await user.click(screen.getByTestId('generic-add-items-submit-btn'));

    expect(h.addFilesToLake).toHaveBeenCalledWith({
      fileIds: ['f-a', 'f-b'],
      lake: { id: 'mine', datalakeTag: 'datalake:mine' },
      skippedCount: 0,
    });
  });

  it('re-checks membership at submit when the list changes under the selection', async () => {
    const user = userEvent.setup();
    const { props, rerender, onClose } = renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-new'));
    // The same search refetches and f-new now carries the lake tag.
    h.files.mockReturnValue({
      data: { pages: [{ data: [{ ...nonMemberFile, tags: [{ name: 'datalake:mine' }] }] }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: false,
    });
    rerender(
      <Wrapper>
        <AddExistingFilesModal lake={props} open onClose={onClose} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('generic-add-items-submit-btn'));

    // The now-member file is not sent, and the refusal keeps the dialog open rather than closing
    // with nothing posted.
    expect(h.addFilesToLake).not.toHaveBeenCalled();
    expect(h.toastInfo).toHaveBeenCalled();
    expect(screen.getByTestId('generic-add-items-modal')).toBeInTheDocument();
  });

  it('cannot be submitted while only an existing member is selected', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-member'));

    expect(screen.getByTestId('generic-add-items-submit-btn')).toBeDisabled();
    expect(h.addFilesToLake).not.toHaveBeenCalled();
  });

  it('calls onClose when the dialog is dismissed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByTestId('generic-add-items-close-btn'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose after a successful add', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-new'));
    await user.click(screen.getByTestId('generic-add-items-submit-btn'));

    expect(h.addFilesToLake).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no built-in trigger when open is controlled', () => {
    const { container } = renderModal();
    expect(container.querySelector('.generic-add-items-modal-trigger')).toBeNull();
  });

  it('shows the draft notice on a draft lake', () => {
    renderModal({ status: 'draft' });
    expect(screen.getByText(/This lake is a draft/)).toBeInTheDocument();
  });

  it('shows the draft notice when the status is absent', () => {
    renderModal({ status: undefined });
    expect(screen.getByText(/This lake is a draft/)).toBeInTheDocument();
  });

  it('disables submit while the file list is refetching, closing the stale-cache reopen window', async () => {
    const user = userEvent.setup();
    h.files.mockReturnValue({
      data: { pages: [{ data: [memberFile, nonMemberFile] }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: true,
    });
    renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-new'));

    expect(screen.getByTestId('generic-add-items-submit-btn')).toBeDisabled();
  });

  it('disables submit while an add for this lake is still in flight elsewhere, closing the reopen-during-POST window', async () => {
    const user = userEvent.setup();
    h.isMutating.mockReturnValue(1);
    renderModal();

    await user.click(screen.getByTestId('datalake-addexisting-item-f-new'));

    expect(screen.getByTestId('generic-add-items-submit-btn')).toBeDisabled();
    expect(h.isMutating).toHaveBeenCalledWith({ mutationKey: ['addFilesToLake'] });
  });

  it('hides the draft notice on an active lake', () => {
    renderModal();
    expect(screen.queryByText(/This lake is a draft/)).toBeNull();
  });
});
