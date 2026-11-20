import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegInviteStatusType } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import RegistrationInvitesTab from './index';
import { useRegistrationInvitesStore } from './store';

type MutationOptions = { onSuccess?: () => void; onError?: () => void };

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  refetch: vi.fn(),
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
  invalidateQueries: vi.fn(),
  isMobile: false,
  options: {} as Record<'create' | 'update' | 'delete', MutationOptions>,
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));
vi.mock('@client/app/hooks/data/regInvites', () => ({
  useGetRegInvites: () => mocks.query,
  useCreateRegInvites: (options: MutationOptions) => {
    mocks.options.create = options;
    return { mutate: mocks.createMutate, isPending: false };
  },
  useUpdateRegInvites: (options: MutationOptions) => {
    mocks.options.update = options;
    return { mutate: mocks.updateMutate };
  },
  useDeleteRegInvites: (options: MutationOptions) => {
    mocks.options.delete = options;
    return { mutate: mocks.deleteMutate };
  },
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('../../common/UsernameText', () => ({ default: ({ id }: { id: string }) => <span>{id}</span> }));
vi.mock('./components/CreateInviteModal', () => ({
  CreateInviteModal: ({ onSubmit }: { onSubmit: (data: { multiple: number }) => void }) => (
    <button data-testid="mock-create-submit" onClick={() => onSubmit({ multiple: 2 })} />
  ),
}));
vi.mock('./components/DeleteConfirmModal', () => ({
  DeleteConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="mock-delete-confirm" onClick={onConfirm} />
  ),
}));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const invite = (n: number, status = RegInviteStatusType.open) => ({
  id: `inv-${n}`,
  code: `CODE-${n}`,
  userId: 'u1',
  status,
  createdAt: new Date(2026, 0, 1, 0, n).toISOString(),
});

const rowAction = async (testId: string) => {
  fireEvent.click(screen.getByTestId('invite-row-actions-inv-1'));
  fireEvent.click(await screen.findByTestId(testId));
};

const setQuery = (overrides: Record<string, unknown>) => {
  mocks.query = {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
    ...overrides,
  };
};

describe('RegistrationInvitesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    useRegistrationInvitesStore.setState({
      activeTab: 'available',
      unusedSelected: [],
      usedSelected: [],
      multiSelected: [],
      openCreate: false,
      operating: false,
      copied: false,
    });
  });

  it('shows an empty state whose create action opens the create modal', () => {
    setQuery({ data: [] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.getByText('No registration invites yet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invite-empty-create-btn'));
    expect(useRegistrationInvitesStore.getState().openCreate).toBe(true);
  });

  it('shows an error state, not the empty state, when the load fails, and retries', () => {
    setQuery({ isError: true });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.queryByText('No registration invites yet')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load registration invites.');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the error state when a refetch fails on an empty list', () => {
    setQuery({ data: [], isError: true });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load registration invites.');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the table when a refetch fails but invites are cached', () => {
    setQuery({ data: [invite(1)], isError: true });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByTestId('invite-code-value')).toHaveLength(1);
  });

  it('switches between the available and used invites', () => {
    setQuery({ data: [invite(1), invite(2, RegInviteStatusType.used)] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('invite-code-value').map(el => el.textContent)).toEqual(['CODE-1']);
    fireEvent.click(screen.getByTestId('invite-used-tab'));
    expect(screen.getAllByTestId('invite-code-value').map(el => el.textContent)).toEqual(['CODE-2']);
    fireEvent.click(screen.getByTestId('invite-available-tab'));
    expect(screen.getAllByTestId('invite-code-value').map(el => el.textContent)).toEqual(['CODE-1']);
  });

  it('selects every code in the tab, not just the visible page, for bulk actions', async () => {
    const all = Array.from({ length: 40 }, (_, i) => invite(i + 1));
    setQuery({ data: all });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('invite-code-card')).toHaveLength(25);
    fireEvent.click(within(screen.getByTestId('invite-table')).getAllByRole('checkbox')[0]);
    const bar = await screen.findByTestId('admin-bulk-action-bar');
    expect(bar).toHaveTextContent('25 selected');

    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    await waitFor(() => expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('40 selected'));

    fireEvent.click(screen.getByRole('button', { name: 'Set Multiple Used' }));
    const call = mocks.updateMutate.mock.calls[0][0] as { ids: string[]; status: RegInviteStatusType };
    expect(call.status).toBe(RegInviteStatusType.used);
    expect([...call.ids].sort()).toEqual(all.map(i => i.id).sort());

    fireEvent.click(screen.getByTestId('invite-bulk-delete-btn'));
    expect(useRegistrationInvitesStore.getState().openDeleteWarning).toBe(true);
    fireEvent.click(screen.getByTestId('mock-delete-confirm'));
    const ids = mocks.deleteMutate.mock.calls[0][0] as string[];
    expect([...ids].sort()).toEqual(all.map(i => i.id).sort());
  });

  it('shows a loading state while the invites load', () => {
    setQuery({ isLoading: true });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });
    expect(screen.getByText('Loading invites')).toBeInTheDocument();
  });

  it.each([false, true])('refreshes and opens the create modal from the header (mobile: %s)', isMobile => {
    mocks.isMobile = isMobile;
    setQuery({ data: [invite(1)] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId('invite-codes-refresh-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('invite-create-btn'));
    expect(useRegistrationInvitesStore.getState().openCreate).toBe(true);
  });

  it.each([false, true])('disables refresh while a refetch is in flight (mobile: %s)', isMobile => {
    mocks.isMobile = isMobile;
    setQuery({ data: [invite(1)], isFetching: true });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });
    expect(screen.getByTestId('invite-codes-refresh-btn')).toBeDisabled();
  });

  it('creates invites and refreshes the codes and package counts on success', () => {
    setQuery({ data: [] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId('mock-create-submit'));
    expect(mocks.createMutate).toHaveBeenCalledWith({ multiple: 2 });
    act(() => useRegistrationInvitesStore.setState({ openCreate: true }));
    act(() => mocks.options.create.onSuccess?.());
    expect(useRegistrationInvitesStore.getState().openCreate).toBe(false);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'delete'] as const)('clears the selection after a %s and unlocks on failure', kind => {
    setQuery({ data: [invite(1)] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    act(() =>
      useRegistrationInvitesStore.setState({ operating: true, unusedSelected: ['inv-1'], usedSelected: ['x'] })
    );
    act(() => mocks.options[kind].onError?.());
    expect(useRegistrationInvitesStore.getState()).toMatchObject({ operating: false, unusedSelected: ['inv-1'] });

    act(() => useRegistrationInvitesStore.setState({ operating: true }));
    act(() => mocks.options[kind].onSuccess?.());
    expect(useRegistrationInvitesStore.getState()).toMatchObject({
      operating: false,
      unusedSelected: [],
      usedSelected: [],
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('updates and deletes a single code from its row', async () => {
    setQuery({ data: [invite(1)] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    await rowAction('invite-set-used-btn');
    expect(mocks.updateMutate).toHaveBeenCalledWith({ ids: ['inv-1'], status: RegInviteStatusType.used });
    act(() => useRegistrationInvitesStore.setState({ operating: false }));
    await rowAction('delete-invite-code-btn');
    expect(mocks.deleteMutate).toHaveBeenCalledWith(['inv-1']);
    expect(useRegistrationInvitesStore.getState().operating).toBe(true);
  });

  it('copies a code and flags it as copied for a moment', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    try {
      setQuery({ data: [invite(1)] });
      render(<RegistrationInvitesTab />, { wrapper: Wrapper });

      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-code-copy-btn'));
      });
      expect(writeText).toHaveBeenCalledWith('CODE-1');
      expect(useRegistrationInvitesStore.getState().copied).toBe(true);
      act(() => vi.advanceTimersByTime(1500));
      expect(useRegistrationInvitesStore.getState().copied).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failed copy without flagging it', async () => {
    const error = new Error('denied');
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(error) } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setQuery({ data: [invite(1)] });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId('invite-code-copy-btn'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('Could not copy text: ', error));
    expect(useRegistrationInvitesStore.getState().copied).toBe(false);
    consoleError.mockRestore();
  });

  it('sorts unlimited codes by expiry into the right tab and formats their dates', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    setQuery({
      data: [
        { ...invite(1), unlimitedUse: true, expiresAt: future },
        { ...invite(2), unlimitedUse: true },
        { ...invite(3), unlimitedUse: true, expiresAt: past },
        { ...invite(4), unlimitedUse: true, expiresAt: 'not-a-date' },
        { ...invite(5), createdAt: undefined },
      ],
    });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    const codes = () => screen.getAllByTestId('invite-code-value').map(el => el.textContent);
    expect([...codes()].sort()).toEqual(['CODE-1', 'CODE-2', 'CODE-5']);
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('invite-used-tab'));
    expect([...codes()].sort()).toEqual(['CODE-3', 'CODE-4']);
  });

  it('orders by creation date both ways, falling back to the id timestamp', () => {
    const hexInvite = (hex: string, createdAt?: string) => ({
      ...invite(0),
      id: `${hex}${'0'.repeat(16)}`,
      code: `HEX-${hex}`,
      createdAt,
    });
    setQuery({
      data: [
        hexInvite('00000001', '2026-01-01T00:00:00.000Z'),
        hexInvite('00000003', '2026-01-03T00:00:00.000Z'),
        hexInvite('00000002'),
        { ...invite(9, RegInviteStatusType.used), createdAt: '2026-01-02T00:00:00.000Z' },
        { ...invite(8, RegInviteStatusType.used), createdAt: '2026-01-04T00:00:00.000Z' },
      ],
    });
    render(<RegistrationInvitesTab />, { wrapper: Wrapper });

    const codes = () => screen.getAllByTestId('invite-code-value').map(el => el.textContent);
    expect(codes()).toEqual(['HEX-00000003', 'HEX-00000002', 'HEX-00000001']);
    fireEvent.click(screen.getByTestId('admin-table-sort-createdAt-btn'));
    expect(codes()).toEqual(['HEX-00000001', 'HEX-00000002', 'HEX-00000003']);

    fireEvent.click(screen.getByTestId('invite-used-tab'));
    expect(codes()).toEqual(['CODE-8', 'CODE-9']);
    fireEvent.click(screen.getByTestId('admin-table-sort-createdAt-btn'));
    expect(codes()).toEqual(['CODE-9', 'CODE-8']);
  });

  describe('reopening package-linked codes', () => {
    const closed = { ...invite(1, RegInviteStatusType.used), grantPackageId: 'pkg-1' };
    const openUsedTab = () => fireEvent.click(screen.getByTestId('invite-used-tab'));

    it('asks for a reason before reopening a closed package code, then sends it', async () => {
      setQuery({ data: [closed] });
      render(<RegistrationInvitesTab />, { wrapper: Wrapper });
      openUsedTab();

      await rowAction('invite-set-open-btn');
      expect(mocks.updateMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('invite-reopen-reason-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('invite-reopen-reason-dialog-reason-input-preset-0'));
      fireEvent.click(screen.getByTestId('invite-reopen-reason-dialog-confirm-btn'));
      expect(mocks.updateMutate).toHaveBeenCalledWith({
        ids: ['inv-1'],
        status: RegInviteStatusType.open,
        reason: expect.any(String),
      });
      expect(useRegistrationInvitesStore.getState().operating).toBe(true);

      act(() => mocks.options.update.onSuccess?.());
      expect(screen.queryByTestId('invite-reopen-reason-dialog')).toBeNull();
    });

    it('asks for a reason when a bulk action reopens a redeemed single-use package code', () => {
      setQuery({ data: [{ ...invite(1, RegInviteStatusType.waiting), grantPackageId: 'pkg-1', used: new Date() }] });
      render(<RegistrationInvitesTab />, { wrapper: Wrapper });

      fireEvent.click(within(screen.getByTestId('invite-table')).getAllByRole('checkbox')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Set Multiple Waiting' }));
      expect(screen.getByTestId('invite-reopen-reason-dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('invite-reopen-reason-dialog-cancel-btn'));
      expect(screen.queryByTestId('invite-reopen-reason-dialog')).toBeNull();
      expect(mocks.updateMutate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('admin-clear-selection-btn'));
      expect(useRegistrationInvitesStore.getState().unusedSelected).toEqual([]);
    });

    it.each([
      ['a code with no package', { ...invite(1, RegInviteStatusType.used) }, RegInviteStatusType.open],
      ['closing a package code', closed, RegInviteStatusType.used],
      [
        'a used unlimited package code',
        { ...invite(1, RegInviteStatusType.waiting), grantPackageId: 'pkg-1', used: new Date(), unlimitedUse: true },
        RegInviteStatusType.open,
      ],
      ['an open package code', { ...invite(1), grantPackageId: 'pkg-1' }, RegInviteStatusType.open],
    ])('updates straight away for %s', async (_label, row, status) => {
      setQuery({ data: [row] });
      render(<RegistrationInvitesTab />, { wrapper: Wrapper });
      if (row.status === RegInviteStatusType.used) openUsedTab();

      await rowAction(`invite-set-${status}-btn`);
      expect(mocks.updateMutate).toHaveBeenCalledWith({ ids: ['inv-1'], status });
      expect(screen.queryByTestId('invite-reopen-reason-dialog')).toBeNull();
    });
  });
});
