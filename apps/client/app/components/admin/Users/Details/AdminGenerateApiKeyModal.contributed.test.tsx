import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminGenerateApiKeyModal from './AdminGenerateApiKeyModal';

const h = vi.hoisted(() => ({ mutate: vi.fn().mockResolvedValue({ key: 'secret' }) }));

vi.mock('@bike4mind/server-utils/premium-generated/premiumApiKeyScopes.generated', () => ({
  premiumApiKeyScopes: [
    { value: 'acme:read', label: 'Acme Read', description: 'Read Acme data', endpoints: [] },
    {
      value: 'acme:write',
      label: 'Acme Write',
      description: 'Write Acme data',
      endpoints: [],
      requiredEntitlement: 'acme:pro',
    },
  ],
}));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => true }));
// The signed-in admin bypasses entitlements, so the gated row is listed even for a target without it.
vi.mock('@client/app/hooks/data/productScopeAccess', () => ({
  useOverwatchAccess: () => true,
  useHearthEnabled: () => true,
  useApiKeyScopeEntitlements: () => ({ bypass: true, entitlements: new Set<string>() }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetPreauthorizableDataLakes: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGenerateApiKey: () => ({ mutateAsync: h.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminGenerateApiKeyModal open onClose={vi.fn()} user={{ id: 'u1', username: 'target-user' } as never} />
    </CssVarsProvider>
  );

const submitScopes = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'k' } });
  fireEvent.click(screen.getByText('Generate API Key'));
  fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-reason-input-preset-0'));
  await act(async () => fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-confirm-btn')));
  return h.mutate.mock.calls.at(-1)![0].data.scopes as string[];
};

describe('AdminGenerateApiKeyModal - contributed scopes', () => {
  it('marks an entitlement-gated contributed scope and keeps it out of Select All', async () => {
    renderModal();
    expect(screen.getByTestId('admin-generate-key-scope-acme:write-entitlement').textContent).toContain('acme:pro');
    expect(screen.queryByTestId('admin-generate-key-scope-acme:read-entitlement')).toBeNull();

    fireEvent.click(screen.getByText('Select All'));
    expect(screen.getByText('Clear All')).toBeTruthy();
    const scopes = await submitScopes();
    expect(scopes).toContain('acme:read');
    expect(scopes).not.toContain('acme:write');
  });

  it('still lets the admin pick the gated scope by hand', async () => {
    renderModal();
    fireEvent.click(screen.getByTestId('admin-generate-key-scope-acme:write').querySelector('input')!);
    expect(await submitScopes()).toEqual(['acme:write']);
  });
});
