import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegInviteStatusType } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import RegistrationInvitesTab from './index';
import { useRegistrationInvitesStore } from './store';

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  refetch: vi.fn(),
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/hooks/data/regInvites', () => ({
  useGetRegInvites: () => mocks.query,
  useCreateRegInvites: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateRegInvites: () => ({ mutate: mocks.updateMutate }),
  useDeleteRegInvites: () => ({ mutate: mocks.deleteMutate }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('../../common/UsernameText', () => ({ default: ({ id }: { id: string }) => <span>{id}</span> }));
vi.mock('./components/CreateInviteModal', () => ({ CreateInviteModal: () => null }));
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
    useRegistrationInvitesStore.setState({
      activeTab: 'available',
      unusedSelected: [],
      usedSelected: [],
      multiSelected: [],
      openCreate: false,
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
});
