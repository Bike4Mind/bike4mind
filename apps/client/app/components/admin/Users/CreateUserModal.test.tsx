import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: apiPost } }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: [] }) }));

// The interceptor tags a dismissed verification prompt with a private symbol; stand in a marker.
const CANCELLED = 'verification-dismissed';
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => error instanceof Error && error.message === CANCELLED,
}));

import CreateUserModal, { useCreateUserModal } from './CreateUserModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const submitWith = async (error: Error) => {
  apiPost.mockRejectedValue(error);
  useCreateUserModal.setState({ open: true });
  render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <CreateUserModal />
      </QueryClientProvider>
    </CssVarsProvider>
  );
  fireEvent.submit(screen.getByTestId('create-user-submit-btn').closest('form')!);
  await waitFor(() => expect(apiPost).toHaveBeenCalled());
};

describe('CreateUserModal - dismissed verification prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('does not show the error alert when the prompt was dismissed', async () => {
    await submitWith(new Error(CANCELLED));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText('Error creating user:')).toBeNull();
  });

  it('shows the error alert for any other failure', async () => {
    await submitWith(new Error('create failed'));

    expect(await screen.findByText('Error creating user:')).toBeTruthy();
    expect(screen.getByText('create failed')).toBeTruthy();
  });
});
