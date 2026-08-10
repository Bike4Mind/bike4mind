import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType } from '@bike4mind/common';
import ShareDocumentModal from './ShareModal';

// ShareModal pulls in several data/context hooks. Stub them so the modal renders
// in isolation. useShareDocument's options are captured so a test can simulate
// react-query's real onError-then-reject sequence on shareDocument.mutateAsync.
const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  mutateAsync: vi.fn(),
  shareDocumentOptions: null as { onError?: (error: unknown) => void } | null,
  currentUser: { id: 'u1', email: 'me@test.com', username: 'me' } as {
    id: string;
    email: string;
    username: string;
  } | null,
}));

vi.mock('@client/app/hooks/data/invites', () => ({
  useShareDocument: (options: { onError?: (error: unknown) => void }) => {
    mocks.shareDocumentOptions = options;
    return { mutate: vi.fn(), mutateAsync: mocks.mutateAsync, data: undefined };
  },
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useUserRevokeSharing: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmation: () => vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.currentUser }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {},
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = () =>
  render(
    <TestWrapper>
      <ShareDocumentModal id="notebook-1" name="My Notebook" type={InviteType.Session} open onClose={vi.fn()} />
    </TestWrapper>
  );

// react-query's mutateAsync always rejects on failure even when onError is provided;
// this mirrors that so tests exercise the same sequence the real hook produces.
const rejectWith = (error: unknown) =>
  mocks.mutateAsync.mockImplementation(async () => {
    mocks.shareDocumentOptions?.onError?.(error);
    throw error;
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutateAsync.mockResolvedValue({});
  mocks.currentUser = { id: 'u1', email: 'me@test.com', username: 'me' };
});

const openByUsersTab = async () => {
  renderModal();
  const user = userEvent.setup();
  await user.click(screen.getByText('By Users'));
  return user;
};

describe('ShareModal - By Link tab', () => {
  it('marks the Description field as optional', () => {
    renderModal();
    // The "By Link" tab is the default (tabIndex 1), so the Description field is visible.
    expect(screen.getByTestId('share-modal-description-label')).toHaveTextContent('Description (Optional)');
  });

  it('enables the Generate button with an empty Description (description is not required)', () => {
    renderModal();
    expect(screen.getByTestId('share-modal-submit-button')).not.toBeDisabled();
  });
});

describe('ShareModal - By Users tab', () => {
  it('fires the share request when a recipient is committed with Enter', async () => {
    const user = await openByUsersTab();
    const input = screen.getByPlaceholderText('Enter email or username - press Enter to add multiple recipients');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('fires the share request from the typed value alone, without pressing Enter', async () => {
    const user = await openByUsersTab();
    const input = screen.getByPlaceholderText('Enter email or username - press Enter to add multiple recipients');
    await user.type(input, 'friend@test.com');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('still fires the share request when currentUser has not loaded yet (regression guard)', async () => {
    mocks.currentUser = null;
    const user = await openByUsersTab();
    const input = screen.getByPlaceholderText('Enter email or username - press Enter to add multiple recipients');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('blocks self-sharing and surfaces one error, without ever calling the API', async () => {
    const user = await openByUsersTab();
    const input = screen.getByPlaceholderText('Enter email or username - press Enter to add multiple recipients');
    // Deliberately not pressing Enter: the Autocomplete's onChange filter already strips a
    // self-share chip on commit, so this exercises the submit-time backstop check instead
    // (the currentInputValue merge at handleShareSubmit), which is what surfaces this message.
    await user.type(input, 'me@test.com');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('You cannot share files to yourself'));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows exactly one error toast, with the server message, when the share request fails', async () => {
    rejectWith({ isAxiosError: true, response: { data: { message: 'File no longer exists' } } });
    const user = await openByUsersTab();
    const input = screen.getByPlaceholderText('Enter email or username - press Enter to add multiple recipients');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('File no longer exists'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });
});
