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
describe('admin target key revocation', () => {
  it('observes generated keys on the canonical cache and marks disabled legacy keys revoked', async () => {
    mocks.permissions = ['support:read', 'keys:revoke'];
    mocks.get.mockResolvedValue({ data: { apiKeys: [], liveUsage: {} } });
    renderKeys();
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
    expect(await screen.findByTestId('admin-key-revoke-key-1')).toBeDisabled();
    expect(screen.getByText('Missing permission: keys:revoke')).toBeInTheDocument();
  });
});
