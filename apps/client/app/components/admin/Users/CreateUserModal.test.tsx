const permissionState = vi.hoisted(() => ({ currentUser: { isAdmin: true, adminPermissions: [] as string[] } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((selector: (state: typeof permissionState) => unknown) => selector(permissionState), {
    getState: () => permissionState,
  }),
}));

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

const renderCreate = () =>
  render(<CreateUserModal />, {
    wrapper: ({ children }) => (
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
          {children}
        </QueryClientProvider>
      </CssVarsProvider>
    ),
  });

describe('delegated create user permissions', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ data: {} });
    permissionState.currentUser = { isAdmin: false, adminPermissions: ['settings:manage'] };
    useCreateUserModal.setState({ open: true });
  });

  it('permits zero-credit creation and disables the credit input without credits:adjust', async () => {
    renderCreate();
    expect(screen.getByTestId('create-user-credits-input').querySelector('input')).toBeDisabled();
    fireEvent.submit(screen.getByTestId('create-user-submit-btn').closest('form')!);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/admin/create-user',
        expect.objectContaining({ initialCredits: 0, isAdmin: false })
      )
    );
    expect(apiPost.mock.calls[0][1]).not.toHaveProperty('roleChangeReason');
  });

  it('requires and sends the reason for creating a full administrator', async () => {
    renderCreate();
    fireEvent.click(screen.getByTestId('create-user-admin-checkbox').querySelector('input')!);
    expect(screen.getByTestId('create-user-submit-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('create-user-role-change-reason'), {
      target: { value: 'Delegate full administration for coverage' },
    });
    fireEvent.submit(screen.getByTestId('create-user-submit-btn').closest('form')!);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/admin/create-user',
        expect.objectContaining({
          isAdmin: true,
          roleChangeReason: 'Delegate full administration for coverage',
          initialCredits: 0,
        })
      )
    );
  });

  it('hides an open create dialog and rejects its saved submit after access is revoked', () => {
    const view = renderCreate();
    const form = screen.getByTestId('create-user-submit-btn').closest('form')!;
    permissionState.currentUser = { isAdmin: false, adminPermissions: [] };
    view.rerender(<CreateUserModal />);
    expect(screen.queryByTestId('create-user-submit-btn')).toBeNull();
    fireEvent.submit(form);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
