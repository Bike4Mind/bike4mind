import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType, IFabFileDocument, ISessionDocument, MAX_BULK_ITEMS } from '@bike4mind/common';
import {
  MAX_EMAIL_MESSAGE_LENGTH,
  MAX_EMAIL_RECIPIENTS,
  MAX_EMAIL_RECIPIENTS_ERROR,
  MAX_INVITE_MESSAGE_LENGTH,
  MAX_INVITE_RECIPIENTS,
  MAX_INVITE_RECIPIENTS_ERROR,
} from '@client/types/api';
import ShareDocumentModal from './ShareModal';

// ShareModal pulls in several data/context hooks. Stub them so the modal renders
// in isolation. useShareDocument's options are captured so a test can simulate
// react-query's real onError-then-reject sequence on shareDocument.mutateAsync.
const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  mutateAsync: vi.fn(),
  batchShare: vi.fn(),
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
  useBatchShare: () => ({ mutateAsync: mocks.batchShare }),
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

  it('tells a notebook owner the link reaches its shareable attached files, before anything is generated', () => {
    renderModal();
    expect(screen.queryByTestId('share-modal-generated-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('share-modal-link-access-note')).toHaveTextContent(
      "Anyone with the link can open this notebook after signing in, along with the attached files you're allowed to share. Links keep working until you turn them off."
    );
  });

  it('keeps the file note free of the notebook-only attached-files wording', () => {
    render(
      <TestWrapper>
        <ShareDocumentModal id="file-1" name="a.pdf" type={InviteType.FabFile} ownerId="u1" open onClose={vi.fn()} />
      </TestWrapper>
    );
    const note = screen.getByTestId('share-modal-link-access-note');
    expect(note).toHaveTextContent(
      'Anyone with the link can open this item after signing in, and can share it on. Links keep working until you turn them off.'
    );
    expect(note).not.toHaveTextContent('attached files');
  });

  it('does not promise an off switch to a file sharer who is not the owner', () => {
    render(
      <TestWrapper>
        <ShareDocumentModal id="file-1" name="a.pdf" type={InviteType.FabFile} ownerId="u2" open onClose={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('share-modal-link-access-note')).toHaveTextContent(
      "Anyone with the link can open this item after signing in, and can share it on. Links don't expire."
    );
    expect(screen.queryByTestId('share-modal-turn-off-links-button')).not.toBeInTheDocument();
  });

  it('describes a bulk link as covering these items, without the attached-files wording', () => {
    renderModal([{ id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument]);
    const note = screen.getByTestId('share-modal-link-access-note');
    expect(note).toHaveTextContent(
      "Anyone with the link can open these items after signing in, and can share it on. Links don't expire."
    );
    expect(note).not.toHaveTextContent('attached files');
  });

  it('tells a bulk notebook sharer the link reaches the notebooks and their shareable attached files', () => {
    render(
      <TestWrapper>
        <ShareDocumentModal
          sessions={[
            { id: 'notebook-1', name: 'One' } as ISessionDocument,
            { id: 'notebook-2', name: 'Two' } as ISessionDocument,
          ]}
          type={InviteType.Session}
          open
          onClose={vi.fn()}
        />
      </TestWrapper>
    );
    expect(screen.getByTestId('share-modal-link-access-note')).toHaveTextContent(
      "Anyone with the link can open these notebooks after signing in, along with the attached files you're allowed to share. Links keep working until you turn them off from each notebook's Share menu."
    );
    expect(screen.queryByTestId('share-modal-turn-off-links-button')).not.toBeInTheDocument();
  });

  it('lets a file owner turn off links for that file after confirmation', async () => {
    render(
      <TestWrapper>
        <ShareDocumentModal id="file-1" name="a.pdf" type={InviteType.FabFile} ownerId="u1" open onClose={vi.fn()} />
      </TestWrapper>
    );
    await userEvent.setup().click(screen.getByTestId('share-modal-turn-off-links-button'));
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.cancelInvite).toHaveBeenCalledWith({ id: 'file-1', type: InviteType.FabFile });
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
    expect(screen.getByTestId('share-modal-link-access-note')).toHaveTextContent(
      "Anyone with the link can open this notebook after signing in, along with the attached files you're allowed to share. Links don't expire."
    );
  });

  it('offers no off switch for a bulk share', () => {
    renderModal([{ id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument]);
    expect(screen.queryByTestId('share-modal-turn-off-links-button')).not.toBeInTheDocument();
  });
});

describe('ShareModal - By Users tab', () => {
  it('blocks more recipients than the invite route accepts without calling the API', async () => {
    const user = await openByUsersTab();
    const input = screen.getByTestId('share-modal-recipients-input');
    await user.click(input);
    for (let i = 0; i <= MAX_INVITE_RECIPIENTS; i++) {
      await user.paste(`u${i}@example.com`);
      await user.keyboard('{Enter}');
    }
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(MAX_INVITE_RECIPIENTS_ERROR));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('caps the description at the server limit', async () => {
    await openByUsersTab();
    expect(screen.getByTestId('share-modal-description-input')).toHaveAttribute(
      'maxLength',
      String(MAX_INVITE_MESSAGE_LENGTH)
    );
  });

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

  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `file-${i + 1}`, fileName: `f${i + 1}.pdf` }) as IFabFileDocument);
  const allOk = async ({ ids }: { ids: string[] }) => ({
    results: ids.map(id => ({ id, ok: true, link: `https://app.example.com/share/t-${id}` })),
    okCount: ids.length,
  });

  it('shares a bulk selection with one batch request instead of one per item', async () => {
    mocks.batchShare.mockImplementation(allOk);
    const user = await openByUsersTab(files(5));
    await user.type(screen.getByTestId('share-modal-recipients-input'), 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Successfully shared 5 files'));
    expect(mocks.batchShare).toHaveBeenCalledTimes(1);
    expect(mocks.batchShare).toHaveBeenCalledWith(
      expect.objectContaining({
        type: InviteType.FabFile,
        ids: ['file-1', 'file-2', 'file-3', 'file-4', 'file-5'],
        recipients: ['friend@test.com'],
      })
    );
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('splits a selection larger than MAX_BULK_ITEMS into one request per chunk', async () => {
    mocks.batchShare.mockImplementation(allOk);
    const user = await openByUsersTab(files(MAX_BULK_ITEMS + 1));
    await user.type(screen.getByTestId('share-modal-recipients-input'), 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.batchShare).toHaveBeenCalledTimes(2));
    expect(mocks.batchShare.mock.calls[0][0].ids).toHaveLength(MAX_BULK_ITEMS);
    expect(mocks.batchShare.mock.calls[1][0].ids).toEqual([`file-${MAX_BULK_ITEMS + 1}`]);
  });

  it('aggregates per-item failures from the batch response into one warning toast', async () => {
    mocks.batchShare.mockResolvedValue({
      results: [
        { id: 'file-1', ok: true, link: 'https://app.example.com/share/t1' },
        { id: 'file-2', ok: false, error: 'Could not find a user for: x' },
      ],
      okCount: 1,
    });
    const user = await openByUsersTab(files(2));
    await user.type(screen.getByTestId('share-modal-recipients-input'), 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledWith('Shared 1 file, but 1 failed: f2.pdf'));
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('reports a rate-limited batch with what was and was not shared', async () => {
    mocks.batchShare.mockResolvedValue({
      results: [
        { id: 'file-1', ok: true, link: 'https://app.example.com/share/t1' },
        { id: 'file-2', ok: false, rateLimited: true, error: 'Too many invitations. Try again later.' },
        { id: 'file-3', ok: false, rateLimited: true, error: 'Too many invitations. Try again later.' },
      ],
      okCount: 1,
      rateLimitMessage: 'Too many invitations. Try again later.',
    });
    const user = await openByUsersTab(files(3));
    await user.type(screen.getByTestId('share-modal-recipients-input'), 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Too many invitations. Try again later. Shared 1 of 3 files. Not shared: f2.pdf, f3.pdf'
      )
    );
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it('does not send later chunks once a chunk is refused by the rate limit', async () => {
    mocks.batchShare.mockRejectedValue({
      isAxiosError: true,
      response: { status: 429, data: { message: 'Slow down.' } },
    });
    const user = await openByUsersTab(files(MAX_BULK_ITEMS + 1));
    await user.type(screen.getByTestId('share-modal-recipients-input'), 'friend@test.com{Enter}');
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error.mock.calls[0][0]).toMatch(/^Slow down\. Shared 0 of 101 files\./);
    expect(mocks.batchShare).toHaveBeenCalledTimes(1);
  });
});

describe('ShareModal - bulk By Link tab', () => {
  it('shows the rate-limit reason when link generation partially succeeds', async () => {
    mocks.batchShare.mockResolvedValue({
      results: [
        { id: 'file-1', ok: true, link: 'https://app.example.com/share/t1' },
        { id: 'file-2', ok: false, rateLimited: true },
      ],
      okCount: 1,
      rateLimitMessage: 'Too many invitations. Try again later.',
    });
    renderModal([
      { id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument,
      { id: 'file-2', fileName: 'b.pdf' } as IFabFileDocument,
    ]);
    await userEvent.setup().click(screen.getByTestId('share-modal-submit-button'));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Too many invitations. Try again later. Generated links for 1 of 2 files. No link for: b.pdf'
      )
    );
    expect(screen.getByTestId('share-modal-generated-link')).toHaveTextContent('/share/t1');
  });

  it('generates every link with one batch request and combines them into one share link', async () => {
    mocks.batchShare.mockResolvedValue({
      results: [
        { id: 'file-1', ok: true, link: 'https://app.example.com/share/t1' },
        { id: 'file-2', ok: true, link: 'https://app.example.com/share/t2' },
      ],
      okCount: 2,
    });
    renderModal([
      { id: 'file-1', fileName: 'a.pdf' } as IFabFileDocument,
      { id: 'file-2', fileName: 'b.pdf' } as IFabFileDocument,
    ]);
    await userEvent.setup().click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(screen.getByTestId('share-modal-generated-link')).toHaveTextContent('https://app.example.com/share/t1,t2')
    );
    expect(mocks.batchShare).toHaveBeenCalledTimes(1);
    expect(mocks.batchShare).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['file-1', 'file-2'], recipients: [] })
    );
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
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

  it('shows the server message when the send is refused', async () => {
    mocks.apiPost.mockRejectedValue({
      isAxiosError: true,
      response: { status: 429, data: { message: 'Email limit reached. Try again in 1800 seconds.' } },
    });
    const user = await openEmailTab();
    await addRecipients(user, 1);
    await user.click(screen.getByTestId('share-modal-submit-button'));

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('Email limit reached. Try again in 1800 seconds.')
    );
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
