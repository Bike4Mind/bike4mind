import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OffboardMemberDialog from './OffboardMemberDialog';

const entry = (count: number, names: string[] = []) => ({
  count,
  sample: names.map((name, index) => ({ id: `${name}-${index}`, name })),
});
const emptyInventory = {
  files: entry(0),
  artifacts: entry(0),
  projects: entry(0),
  notebooks: entry(0),
  agents: entry(0),
  orgBilledApiKeys: { count: 0 },
};

const hooks = vi.hoisted(() => ({
  inventory: { data: undefined as unknown, isLoading: false, error: null as unknown },
  mutateAsync: vi.fn(),
  isPending: false,
  refetch: vi.fn(),
  refreshOrganization: vi.fn(),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useMemberOffboardingInventory: () => ({ ...hooks.inventory, refetch: hooks.refetch }),
  useGetOrganization: () => ({
    refetch: hooks.refreshOrganization,
    data: {
      id: 'org1',
      userId: 'owner1',
      users: [
        { userId: 'b', permissions: ['read'] },
        { userId: 'c', permissions: ['read'] },
        { userId: 'pending', permissions: [] },
      ],
    },
  }),
  useRemoveMemberFromOrganization: () => ({ mutateAsync: hooks.mutateAsync, isPending: hooks.isPending }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({
    data: [
      { id: 'owner1', name: 'Owner' },
      { id: 'b', name: 'Bea' },
      { id: 'c', name: 'Cal' },
      { id: 'pending', name: 'Pat' },
    ],
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderDialog = (onClose = vi.fn()) => {
  render(<OffboardMemberDialog organizationId="org1" member={{ id: 'b', name: 'Bea' }} onClose={onClose} />, {
    wrapper: TestWrapper,
  });
  return onClose;
};

const confirmButton = () => screen.getByTestId('offboard-dialog-confirm-btn') as HTMLButtonElement;

describe('OffboardMemberDialog', () => {
  beforeEach(() => {
    hooks.mutateAsync.mockReset().mockResolvedValue(0);
    hooks.isPending = false;
    hooks.refetch.mockReset().mockResolvedValue(undefined);
    hooks.refreshOrganization.mockReset().mockResolvedValue(undefined);
    hooks.inventory = {
      data: {
        ...emptyInventory,
        files: entry(2, ['plan.pdf', 'notes.md']),
        agents: entry(1, ['Helper']),
        orgBilledApiKeys: { count: 1 },
      },
      isLoading: false,
      error: null,
    };
  });

  it('removes without a transfer when the member owns nothing', async () => {
    hooks.inventory = { data: emptyInventory, isLoading: false, error: null };
    const onClose = renderDialog();

    expect(screen.getByTestId('offboard-dialog-empty')).toBeTruthy();
    expect(screen.queryByTestId('offboard-dialog-transfer-radio')).toBeNull();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(hooks.mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'b' });
  });

  it('allows removal of an accepted roster row without membership permissions', async () => {
    hooks.inventory = { data: emptyInventory, isLoading: false, error: null };
    render(<OffboardMemberDialog organizationId="org1" member={{ id: 'pending', name: 'Pat' }} onClose={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(confirmButton()).toBeEnabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'pending' }));
  });

  it('lists counts and samples, keeping content with the member by default', async () => {
    renderDialog();

    expect(screen.getByTestId('offboard-dialog-count-files').textContent).toContain('plan.pdf, notes.md');
    expect(screen.getByTestId('offboard-dialog-count-agents').textContent).toContain('Agents: 1');
    expect(screen.queryByTestId('offboard-dialog-count-projects')).toBeNull();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'b' }));
  });

  it('holds the transfer until a target is picked, then sends it', async () => {
    renderDialog();

    fireEvent.click(screen.getByLabelText('Transfer to another member'));
    expect(confirmButton().disabled).toBe(true);

    fireEvent.click(within(screen.getByTestId('offboard-dialog-target-select')).getByRole('combobox'));
    expect(screen.queryByTestId('offboard-dialog-target-b')).toBeNull();
    // A roster row without a membership permission is not offered as a recipient.
    expect(screen.queryByTestId('offboard-dialog-target-pending')).toBeNull();
    fireEvent.click(await screen.findByTestId('offboard-dialog-target-c'));
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(hooks.mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'b', reassignTo: 'c' })
    );
  });

  it('stays open when the removal fails', async () => {
    hooks.mutateAsync.mockRejectedValueOnce(new Error('nope'));
    const onClose = renderDialog();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the load error and blocks removal until the content has loaded', () => {
    hooks.inventory = { data: undefined, isLoading: false, error: new Error('boom') };
    renderDialog();

    expect(screen.getByTestId('offboard-dialog-error').textContent).toContain('boom');
    expect(confirmButton().disabled).toBe(true);
  });

  it('removes without a transfer when refreshed inventory becomes empty after choosing transfer', async () => {
    const onClose = vi.fn();
    const dialog = () => (
      <OffboardMemberDialog organizationId="org1" member={{ id: 'b', name: 'Bea' }} onClose={onClose} />
    );
    const view = render(dialog(), { wrapper: TestWrapper });
    fireEvent.click(screen.getByLabelText('Transfer to another member'));
    expect(confirmButton()).toBeDisabled();

    hooks.inventory.data = emptyInventory;
    view.rerender(dialog());

    expect(screen.queryByTestId('offboard-dialog-target-select')).toBeNull();
    expect(confirmButton()).toBeEnabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'b' }));
  });

  it('keeps dismissal and another submission disabled while removal is pending', () => {
    hooks.isPending = true;
    const onClose = renderDialog();
    const cancel = screen.getByTestId('offboard-dialog-cancel-btn');
    const close = screen.getByRole('button', { name: 'Close removal dialog' });
    expect(cancel).toBeDisabled();
    expect(close).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByTestId('offboard-dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(hooks.mutateAsync).not.toHaveBeenCalled();
  });

  it('labels the recipient selector', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Transfer to another member'));
    expect(screen.getByRole('combobox', { name: 'Transfer team content to' })).toBeInTheDocument();
  });

  it('offers a visible retry after inventory fails while keeping removal blocked', () => {
    hooks.inventory = { data: undefined, isLoading: false, error: new Error('boom') };
    renderDialog();
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(hooks.refetch).toHaveBeenCalledTimes(1);
  });
});
