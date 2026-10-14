import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  patch: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: mocks.patch } }));
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: {} }) }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({
    currentUser: { id: 'u1', platformEmailAddress: 'jane@example.com', authorizedEmailAddresses: ['a@example.com'] },
  }),
}));

import EmailIntegrationSection from './EmailIntegrationSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <EmailIntegrationSection />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('EmailIntegrationSection save errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows the server error message when the save is rejected', async () => {
    mocks.patch.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: 'Platform email local part is reserved' } },
    });
    renderSection();
    await userEvent.setup().click(screen.getByTestId('save-email-settings-btn'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Platform email local part is reserved'));
  });

  it('falls back to a generic message when the server sends none', async () => {
    mocks.patch.mockRejectedValue(new Error('Network Error'));
    renderSection();
    await userEvent.setup().click(screen.getByTestId('save-email-settings-btn'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Failed to update email settings'));
  });
});
