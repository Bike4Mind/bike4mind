import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationServiceKeys from './OrganizationServiceKeys';
const api = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ data: [] }),
  post: vi.fn().mockResolvedValue({ data: { key: 'one-time-secret' } }),
  delete: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

describe('organization service keys', () => {
  it('requires explicit grants and displays the minted secret only until dismissed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
          <OrganizationServiceKeys organizationId="org" />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    const create = screen.getByTestId('org-service-keys-create-btn');
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('org-service-keys-name-input').querySelector('input')!, {
      target: { value: 'automation' },
    });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-service-keys-compute-checkbox').querySelector('input')!);
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('org-service-keys-secret-alert')).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/api/organizations/org/service-keys', {
      name: 'automation',
      scopes: ['ai:chat'],
      grants: [{ resourceType: 'organization', resourceId: 'org', permission: 'compute' }],
    });
    fireEvent.click(screen.getByTestId('org-service-keys-dismiss-btn'));
    expect(screen.queryByTestId('org-service-keys-secret-alert')).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map(mutation => mutation.state.data)
      )
    ).not.toContain('one-time-secret');
  });
});
