import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('CreateUserModal - dismissal', () => {
  it('ignores Escape and disables the close button while the create request is in flight', async () => {
    let finish: (value: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise(resolve => (finish = resolve)));
    useCreateUserModal.setState({ open: true });
    render(
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
          <CreateUserModal />
        </QueryClientProvider>
      </CssVarsProvider>
    );
    expect(screen.getByRole('dialog', { name: 'Create new user' })).toBeTruthy();
    fireEvent.submit(screen.getByTestId('create-user-submit-btn').closest('form')!);
    await waitFor(() => expect(screen.getByTestId('create-user-modal-close-btn')).toHaveProperty('disabled', true));
    fireEvent.keyDown(screen.getByTestId('create-user-modal'), { key: 'Escape' });
    expect(useCreateUserModal.getState().open).toBe(true);
    await act(async () => finish({ data: {} }));
  });

  it('closes on Escape when idle', () => {
    useCreateUserModal.setState({ open: true });
    render(
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={new QueryClient()}>
          <CreateUserModal />
        </QueryClientProvider>
      </CssVarsProvider>
    );
    fireEvent.keyDown(screen.getByTestId('create-user-modal'), { key: 'Escape' });
    expect(useCreateUserModal.getState().open).toBe(false);
  });
});

describe('CreateUserModal - storage limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({ data: {} });
  });

  it.each([
    ['', 250],
    ['0', 0],
  ])('entering "%s" submits storageLimit %i', async (value, storageLimit) => {
    useCreateUserModal.setState({ open: true });
    render(
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
          <CreateUserModal />
        </QueryClientProvider>
      </CssVarsProvider>
    );
    const input = screen.getByTestId('create-user-storage-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(screen.getByTestId('create-user-submit-btn').closest('form')!);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/admin/create-user', expect.objectContaining({ storageLimit }))
    );
  });
});
