import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationLibrarySection from './OrganizationLibrarySection';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
const theme = extendTheme({ ...getThemeConfig() });
const ID = '0123456789abcdef01234567';
function renderSection(canManage: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<OrganizationLibrarySection organizationId="org" canManage={canManage} />, { wrapper });
}

describe('organization library management UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (_url: string, config?: { params?: { sources?: string } }) => ({
      data: config?.params?.sources
        ? { sources: [{ id: ID, name: 'Personal helper' }] }
        : {
            items: [
              { id: ID, organizationId: 'org', kind: 'agent', name: 'Team helper', description: 'Help', pinned: false },
            ],
          },
    }));
    api.post.mockResolvedValue({});
    api.patch.mockResolvedValue({});
  });

  it('lets an admin select and publish a personal item, then pin a library item', async () => {
    renderSection(true);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/organizations/org/library', { params: { sources: 'agent' } })
    );
    fireEvent.mouseDown(screen.getByTestId('organization-library-source-select'));
    fireEvent.click(await screen.findByText('Personal helper'));
    fireEvent.click(screen.getByTestId('organization-library-publish-btn'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/organizations/org/library', { kind: 'agent', sourceId: ID })
    );
    await waitFor(() => expect(screen.getByTestId('organization-library-pin-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('organization-library-pin-btn'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/organizations/org/library', { itemId: ID, pinned: true })
    );
  });

  it('shows members the reuse picker but no publishing, pinning, removal or personal source requests', async () => {
    renderSection(false);
    await screen.findByTestId('organization-library-item');
    expect(screen.getByTestId('organization-library-picker')).toBeTruthy();
    expect(screen.queryByTestId('organization-library-publish-btn')).toBeNull();
    expect(screen.queryByTestId('organization-library-pin-btn')).toBeNull();
    expect(screen.queryByTestId('organization-library-remove-btn')).toBeNull();
    expect(api.get.mock.calls.every(([, config]) => !config?.params?.sources)).toBe(true);
  });
});
