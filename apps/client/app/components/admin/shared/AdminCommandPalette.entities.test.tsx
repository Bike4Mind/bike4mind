import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { get, navigate } = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn() }));
vi.mock('@client/app/contexts/apiClient', () => ({ api: { get } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
import { AdminCommandPalette } from './AdminCommandPalette';
const theme = extendTheme({ ...getThemeConfig() });
const userId = 'a'.repeat(24);

function setup() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={theme}>
        <AdminCommandPalette enableEntitySearch />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  return screen.getByTestId('admin-search-input');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('entity search palette', () => {
  it('debounces, shows typed masked results, and opens the keyboard selection', async () => {
    get.mockResolvedValue({
      data: {
        results: [
          { type: 'user', id: userId, displayName: 'Example user', secondary: 'e***@example.com' },
          { type: 'organization', id: 'b'.repeat(24), displayName: 'Example org', secondary: 'ID ...bbbbbb' },
        ],
      },
    });
    const input = setup();
    fireEvent.change(input, { target: { value: 'example@example.com' } });
    expect(get).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: /Users: Example user/ });
    expect(screen.getByRole('option', { name: /Organizations: Example org/ })).toBeVisible();
    expect(get).toHaveBeenCalledWith(
      '/api/admin/search',
      expect.objectContaining({ params: { q: 'example@example.com' }, signal: expect.any(AbortSignal) })
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/admin?tab=organizations&orgId=' + 'b'.repeat(24) })
    );
  });
  it('clears stale results as soon as the query changes and displays failures', async () => {
    get.mockResolvedValueOnce({
      data: { results: [{ type: 'user', id: userId, displayName: 'First', secondary: 'f***@example.com' }] },
    });
    const input = setup();
    fireEvent.change(input, { target: { value: 'first@example.com' } });
    await screen.findByRole('option', { name: /Users: First/ });
    get.mockRejectedValue(new Error('Unavailable'));
    fireEvent.change(input, { target: { value: 'second@example.com' } });
    expect(screen.queryByRole('option', { name: /Users: First/ })).not.toBeInTheDocument();
    await screen.findByRole('alert');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument());
  });
  it('never sends a pasted full API key', async () => {
    const input = setup();
    fireEvent.change(input, { target: { value: 'b4m_live_' + 'a'.repeat(32) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('never a full key');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(get).not.toHaveBeenCalled();
  });
});
