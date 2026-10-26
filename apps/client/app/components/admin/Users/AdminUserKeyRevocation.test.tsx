import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ApiKeyStatus, type IUserApiKeyDocument } from '@bike4mind/common';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminUserKeyRevocation } from './AdminUserKeyRevocation';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), permissions: ['support:read', 'keys:revoke'] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: { isAdmin: boolean; adminPermissions: string[] } }) => unknown) =>
    selector({ currentUser: { isAdmin: false, adminPermissions: mocks.permissions } }),
}));
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const renderKeys = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
        <AdminUserKeyRevocation userId="target" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
const expandKeys = () => fireEvent.click(screen.getByTestId('admin-user-key-revocation-expand'));
describe('admin target key revocation', () => {
  it('fetches nothing until the keys are expanded', async () => {
    mocks.permissions = ['support:read', 'keys:revoke'];
    mocks.get.mockClear();
    mocks.get.mockResolvedValue({ data: { apiKeys: [], liveUsage: {} } });
    renderKeys();
    expect(mocks.get).not.toHaveBeenCalled();
    expandKeys();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/users/target/user-api-keys'));
    queryClient.clear();
  });
  it('shows loading only on the key being revoked', async () => {
    mocks.permissions = ['support:read', 'keys:revoke'];
    mocks.get.mockResolvedValue({
      data: {
        apiKeys: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
        liveUsage: {},
      },
    });
    mocks.post.mockReturnValue(new Promise(() => {}));
    renderKeys();
    expandKeys();
    const first = await screen.findByTestId('admin-key-revoke-a');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Revoke compromised support key' } });
    fireEvent.click(first);
    await waitFor(() => expect(screen.getByTestId('admin-key-revoke-a')).toHaveClass('MuiButton-loading'));
    expect(screen.getByTestId('admin-key-revoke-b')).not.toHaveClass('MuiButton-loading');
    queryClient.clear();
  });
  it('observes generated keys on the canonical cache and marks disabled legacy keys revoked', async () => {
    mocks.permissions = ['support:read', 'keys:revoke'];
    mocks.get.mockResolvedValue({ data: { apiKeys: [], liveUsage: {} } });
    renderKeys();
    expandKeys();
    await screen.findByText('No API keys');
    act(() =>
      queryClient.setQueryData(['admin', 'user-api-keys', 'target'], {
        apiKeys: [{ id: 'legacy', name: 'Legacy key', status: ApiKeyStatus.DISABLED } as IUserApiKeyDocument],
        liveUsage: {},
      })
    );
    const button = await screen.findByTestId('admin-key-revoke-legacy');
    expect(button).toHaveTextContent('Revoked');
    expect(button).toBeDisabled();
    queryClient.clear();
  });
  it('requires a reason and revokes the selected target key', async () => {
    mocks.permissions = ['support:read', 'keys:revoke'];
    mocks.get.mockResolvedValue({ data: { apiKeys: [{ id: 'key-1', name: 'Support client' }], liveUsage: {} } });
    mocks.post.mockResolvedValue({ data: { success: true } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderKeys();
    expandKeys();
    const button = await screen.findByTestId('admin-key-revoke-key-1');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Revoke compromised support key' } });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/user-api-keys/key-1/revoke', {
        reason: 'Revoke compromised support key',
      })
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-api-keys', 'target'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user-api-keys'] });
  });
  it('keeps support read access from revoking keys', async () => {
    mocks.permissions = ['support:read'];
    mocks.get.mockResolvedValue({ data: { apiKeys: [{ id: 'key-1', name: 'Support client' }], liveUsage: {} } });
    renderKeys();
    expandKeys();
    expect(await screen.findByTestId('admin-key-revoke-key-1')).toBeDisabled();
    expect(screen.getByText('Missing permission: keys:revoke')).toBeInTheDocument();
  });
});
