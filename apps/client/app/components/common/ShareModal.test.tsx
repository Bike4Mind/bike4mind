import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType, IFabFileDocument } from '@bike4mind/common';
import { MAX_EMAIL_MESSAGE_LENGTH, MAX_EMAIL_RECIPIENTS, MAX_EMAIL_RECIPIENTS_ERROR } from '@client/types/api';
import ShareDocumentModal from './ShareModal';

// ShareModal pulls in several data/context hooks. Stub them so the modal renders
// in isolation. useShareDocument's options are captured so a test can simulate
// react-query's real onError-then-reject sequence on shareDocument.mutateAsync.
const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  mutateAsync: vi.fn(),
  shareDocumentOptions: null as { onError?: (error: unknown) => void } | null,
  shareData: undefined as { link: string } | undefined,
  cancelInvite: vi.fn(),
  confirm: vi.fn(),
  apiPost: vi.fn(),
  currentUser: { id: 'u1', email: 'me@test.com', username: 'me' } as {
    id: string;
    email: string;
    username: string;
  } | null,
}));

vi.mock('@client/app/hooks/data/invites', () => ({
  useShareDocument: (options: { onError?: (error: unknown) => void }) => {
    mocks.shareDocumentOptions = options;
    return { mutate: vi.fn(), mutateAsync: mocks.mutateAsync, data: mocks.shareData };
  },
  useCancelInvite: () => ({ mutate: mocks.cancelInvite, isPending: false }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useUserRevokeSharing: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmation: () => mocks.confirm,
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.currentUser }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: mocks.apiPost },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = (files?: IFabFileDocument[], ownerId = 'u1') =>
  render(
    <TestWrapper>
      {files ? (
        <ShareDocumentModal files={files} type={InviteType.FabFile} open onClose={vi.fn()} />
      ) : (
        <ShareDocumentModal
          id="notebook-1"
          name="My Notebook"
          type={InviteType.Session}
          ownerId={ownerId}
          open
          onClose={vi.fn()}
        />
      )}
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
  mocks.shareData = undefined;
  mocks.currentUser = { id: 'u1', email: 'me@test.com', username: 'me' };
});

const openByUsersTab = async (files?: IFabFileDocument[]) => {
  renderModal(files);
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

  it('says who can open the link', () => {
    renderModal();
    expect(screen.getByTestId('share-modal-link-access-note')).toHaveTextContent(
      'Anyone with the link can open this notebook after signing in'
    );
  });

  it('shows the whole generated link as text next to a labelled copy button', () => {
    const link = 'https://app.example.com/share/0123456789abcdef0123456789abcdef';
    mocks.shareData = { link };
    renderModal();
    expect(screen.getByTestId('share-modal-generated-link')).toHaveTextContent(link);
    expect(screen.getByTestId('share-modal-copy-button')).toHaveAccessibleName('Copy link');
  });

  it('turns off links for the document only after confirmation', async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('share-modal-turn-off-links-button'));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.cancelInvite).not.toHaveBeenCalled();
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.cancelInvite).toHaveBeenCalledWith({ id: 'notebook-1', type: InviteType.Session });
  });

  it('offers no off switch to a sharee, since the cancel route is owner-only', () => {
    renderModal(undefined, 'someone-else');
    expect(screen.queryByTestId('share-modal-turn-off-links-button')).not.toBeInTheDocument();
  });

  it('offers no off switch for a bulk share', () => {
    renderModal([{ id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument]);
    expect(screen.queryByTestId('share-modal-turn-off-links-button')).not.toBeInTheDocument();
  });
});

describe('ShareModal - By Users tab', () => {
  it('fires the share request when a recipient is committed with Enter', async () => {
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('fires the share request from the typed value alone, without pressing Enter', async () => {
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('reports the server-resolved recipient count in the success toast, not the raw typed count', async () => {
    // Two typed recipients (an email and that same person's username) resolve server-side
    // to one unique person - the toast must say "1 recipient", not "2 recipients".
    mocks.mutateAsync.mockResolvedValue({ recipients: { pending: ['friend@test.com'] } });
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com{Enter}friend{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith('Successfully shared My Notebook to 1 recipient')
    );
  });

  it('still fires the share request when currentUser has not loaded yet (regression guard)', async () => {
    mocks.currentUser = null;
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['friend@test.com'] }))
    );
  });

  it('blocks self-sharing and surfaces one error, without ever calling the API', async () => {
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    // Deliberately not pressing Enter: the Autocomplete's onChange filter already strips a
    // self-share chip on commit, so this exercises the submit-time backstop check instead
    // (the currentInputValue merge at handleShareSubmit), which is what surfaces this message.
    await user.type(input, 'me@test.com');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('You cannot share files to yourself'));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('blocks a case-varied self-share too, matching the server side case-insensitive resolution', async () => {
    // Regression guard: the server now resolves recipients case-insensitively, so a
    // differently-cased self-share must still be caught client-side or it would silently
    // create a real self-invite instead of erroring. Pressing Enter would route this through
    // the onChange filter instead (also fixed, but then the array is empty by submit time and
    // "Recipients is required" fires first) - the backstop path is what this test targets.
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'Me@Test.com');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('You cannot share files to yourself'));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('the onChange filter also strips a case-varied self-share chip before submit', async () => {
    // Exercises the OTHER guard (the Autocomplete onChange filter, not the submit backstop):
    // committing a case-varied self-share with Enter must still end up with nothing to submit.
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'Me@Test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Recipients is required'));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows exactly one error toast, with the server message, when the share request fails', async () => {
    rejectWith({ isAxiosError: true, response: { data: { message: 'File no longer exists' } } });
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('File no longer exists'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });

  it('aggregates a bulk share failure into one toast instead of a per-item duplicate', async () => {
    // First file shares fine; the second's mutateAsync fails (e.g. an unresolved recipient),
    // exercising the same onError path as the single-item case but through the bulk loop.
    mocks.mutateAsync
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        const error = { isAxiosError: true, response: { data: { message: 'Could not find a user for: x' } } };
        mocks.shareDocumentOptions?.onError?.(error);
        throw error;
      });

    const user = await openByUsersTab([
      { id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument,
      { id: 'file-2', fileName: 'b.pdf' } as IFabFileDocument,
    ]);
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.type(input, 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2));
    // showBulkFeedback's own aggregate toast (a partial success -> toast.warning) is the only
    // one that should fire; the per-item onError toast must stay suppressed for bulk shares.
    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});

describe('ShareModal - Email tab', () => {
  const openEmailTab = async () => {
    render(
      <TestWrapper>
        <ShareDocumentModal id="file-1" name="a.pdf" type={InviteType.FabFile} ownerId="u1" open onClose={vi.fn()} />
      </TestWrapper>
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('Email'));
    return user;
  };

  const addRecipients = async (user: ReturnType<typeof userEvent.setup>, count: number) => {
    const input = screen.getByTestId('share-modal-recipients-input');
    for (let i = 0; i < count; i++) {
      await user.type(input, `u${i}@example.com{Enter}`);
    }
  };

  it('blocks more recipients than the server accepts without calling the API', async () => {
    const user = await openEmailTab();
    await addRecipients(user, MAX_EMAIL_RECIPIENTS + 1);
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(MAX_EMAIL_RECIPIENTS_ERROR));
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('sends a recipient list at the maximum', async () => {
    mocks.apiPost.mockResolvedValue({ data: { success: true, message: 'sent' } });
    const user = await openEmailTab();
    await addRecipients(user, MAX_EMAIL_RECIPIENTS);
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost.mock.calls[0][1].recipients).toHaveLength(MAX_EMAIL_RECIPIENTS);
  });

  it('caps the personal message at the server limit', async () => {
    await openEmailTab();
    expect(screen.getByTestId('share-modal-email-message-input')).toHaveAttribute(
      'maxLength',
      String(MAX_EMAIL_MESSAGE_LENGTH)
    );
  });

  it('shows how much of the message limit is used', async () => {
    const user = await openEmailTab();
    expect(screen.getByTestId('share-modal-email-message-count')).toHaveTextContent(`0/${MAX_EMAIL_MESSAGE_LENGTH}`);
    await user.type(screen.getByTestId('share-modal-email-message-input'), 'hello');
    expect(screen.getByTestId('share-modal-email-message-count')).toHaveTextContent(`5/${MAX_EMAIL_MESSAGE_LENGTH}`);
  });
});
