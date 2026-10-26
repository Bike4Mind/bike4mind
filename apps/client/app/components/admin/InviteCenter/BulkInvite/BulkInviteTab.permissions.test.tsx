import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import BulkInviteTab from './BulkInviteTab';

const state = vi.hoisted(() => ({
  currentUser: { isAdmin: false, adminPermissions: ['settings:manage'] },
  post: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: state.post } }));

const renderBulk = () =>
  render(
    <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
      <BulkInviteTab quickAction={null} />
    </CssVarsProvider>
  );

describe('bulk invite starting credit permissions', () => {
  it('allows a settings delegate to create users with zero credits', async () => {
    state.currentUser.adminPermissions = ['settings:manage'];
    state.post.mockResolvedValue({
      data: { success: true, results: [{ email: 'target@example.com', success: true }] },
    });
    renderBulk();
    const email = screen.getAllByTestId(/^bulk-invite-email-/)[0].querySelector('input')!;
    const credit = screen.getAllByTestId(/^bulk-invite-credits-/)[0].querySelector('input')!;
    expect(credit).toBeDisabled();
    fireEvent.change(email, { target: { value: 'target@example.com' } });
    fireEvent.click(screen.getByTestId('bulk-invite-send-all-btn'));
    await waitFor(() =>
      expect(state.post).toHaveBeenCalledWith('/api/admin/bulk-create-users', {
        users: [expect.objectContaining({ email: 'target@example.com', startingCredits: 0 })],
      })
    );
  });
});
