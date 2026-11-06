import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EraseUserDialog } from './EraseUserDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));

const PREVIEW = {
  generatedAt: '2026-11-06T10:00:00.000Z',
  collections: [
    { model: 'Quest', deleted: 4, anonymized: 0, retained: 0, retainReasons: [] },
    { model: 'CreditTransaction', deleted: 0, anonymized: 2, retained: 5, retainReasons: ['Tax records'] },
  ],
};

const setup = () => {
  const user = buildProfile();
  const onClose = vi.fn();
  render(<EraseUserDialog user={user} onClose={onClose} />, { wrapper: ProfileTestWrapper });
  return { user, onClose };
};

const runDryRun = async () => {
  fireEvent.click(await screen.findByTestId('erase-user-preview-dialog-reason-input-preset-0'));
  await waitFor(() => expect(screen.getByTestId('erase-user-preview-dialog-confirm-btn')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('erase-user-preview-dialog-confirm-btn'));
  await screen.findByTestId('erase-user-dialog');
};

describe('EraseUserDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ data: { state: 'none' } });
    mocks.post.mockImplementation(async (url: string) =>
      url.endsWith('/preview') ? { data: PREVIEW } : { data: { queued: true } }
    );
  });

  it.each([
    ['selfDeletionPending', { state: 'selfDeletionPending', scheduledFor: '2026-11-20T00:00:00.000Z' }],
    [
      'requested',
      { state: 'requested', requestedAt: '2026-11-06T09:00:00.000Z', requestedBy: 'a', purgeStartedAt: null },
    ],
  ])('disables the dry run with a pending message when the state is %s', async (_name, data) => {
    mocks.get.mockResolvedValue({ data });
    setup();

    expect(await screen.findByTestId('erase-user-pending')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('erase-user-preview-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('erase-user-preview-dialog-confirm-btn')).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('posts the dry run with the reason, then shows the preview rows in the danger step', async () => {
    const { user } = setup();

    await runDryRun();

    expect(mocks.get).toHaveBeenCalledWith(`/api/admin/users/${user.id}/erasure`);
    expect(mocks.post).toHaveBeenCalledWith(`/api/admin/users/${user.id}/erasure/preview`, {
      reason: expect.stringContaining('GDPR Art. 17'),
    });
    expect(screen.getAllByTestId('erase-user-scope-row')).toHaveLength(2);
  });

  it('keeps the erase confirm disabled until the email is typed, then erases and closes', async () => {
    const { user, onClose } = setup();
    await runDryRun();

    // The erase step takes its own reason: none is carried over from the dry run.
    fireEvent.change(screen.getByTestId('erase-user-dialog-typed-input'), { target: { value: user.email } });
    expect(screen.getByTestId('erase-user-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('erase-user-dialog-reason-input-preset-0'));
    await waitFor(() => expect(screen.getByTestId('erase-user-dialog-confirm-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('erase-user-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(`/api/admin/users/${user.id}/erasure`, {
        reason: expect.stringContaining('GDPR Art. 17'),
      })
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Erasure started')));
    expect(onClose).toHaveBeenCalled();
  });

  it('tells the admin the daily run removes the data when the queue was unreachable', async () => {
    mocks.post.mockImplementation(async (url: string) =>
      url.endsWith('/preview') ? { data: PREVIEW } : { data: { queued: false } }
    );
    const { user } = setup();
    await runDryRun();
    fireEvent.click(screen.getByTestId('erase-user-dialog-reason-input-preset-0'));
    fireEvent.change(screen.getByTestId('erase-user-dialog-typed-input'), { target: { value: user.email } });
    await waitFor(() => expect(screen.getByTestId('erase-user-dialog-confirm-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('erase-user-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('daily deletion run')));
  });
});
