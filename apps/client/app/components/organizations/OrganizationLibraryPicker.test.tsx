import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationLibraryPicker from './OrganizationLibraryPicker';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
const theme = extendTheme({ ...getThemeConfig() });

describe('member library picker', () => {
  it('displays pinned org items and imports a selected skill through the regular creation API', async () => {
    const item = { id: 'published', kind: 'skill', name: 'Team helper', pinned: true, organizationId: 'org' };
    api.get.mockImplementation(async (url: string) => ({
      data:
        url === '/api/organization-library'
          ? { items: [item] }
          : { item: { ...item, definition: { name: 'team-helper', description: 'Help', body: 'Instructions' } } },
    }));
    api.post.mockResolvedValue({ data: { id: 'personal-copy' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
      </QueryClientProvider>
    );
    render(<OrganizationLibraryPicker kind="skill" />, { wrapper });
    expect(screen.getByTestId('organization-library-reuse-btn')).toBeDisabled();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByTestId('organization-library-picker-select'));
    await waitFor(() => expect(screen.getByText('Pinned: Team helper (skill)')).toBeTruthy());
    fireEvent.click(screen.getByText('Pinned: Team helper (skill)'));
    fireEvent.click(screen.getByTestId('organization-library-reuse-btn'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/skills', {
        name: 'team-helper',
        description: 'Help',
        body: 'Instructions',
      })
    );
    await waitFor(() => expect(screen.getByText('Added to your picker.')).toBeTruthy());
  });
});
