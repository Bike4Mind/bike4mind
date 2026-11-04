import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: { connected: false } }) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/hooks/data/mcpServers', () => ({ mcpServerKeys: { list: () => ['mcp-servers'] } }));
vi.mock('../SectionContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./GitHubNotificationsSection', () => ({ default: () => null }));

import GitHubIntegrationSection from './GitHubIntegrationSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithSearch = (search: string) => {
  window.history.replaceState(null, '', `/profile${search}`);
  return render(
    <CssVarsProvider theme={appTheme}>
      <GitHubIntegrationSection userId="u1" />
    </CssVarsProvider>
  );
};

describe('GitHubIntegrationSection OAuth callback toast', () => {
  beforeEach(() => {
    h.toastError.mockClear();
    h.navigate.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('tells the user a declined consent was cancelled', async () => {
    renderWithSearch('?github_oauth=error&error=access_denied');

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('GitHub authorization was cancelled.'));
  });

  it('falls back to a generic message for an unknown error code', async () => {
    renderWithSearch('?github_oauth=error&error=not_a_known_code');

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('An unknown error occurred'));
  });
});
