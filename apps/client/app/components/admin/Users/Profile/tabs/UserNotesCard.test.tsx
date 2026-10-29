import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';
import { UserNotesCard } from './UserNotesCard';

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  identity: { isAdmin: true, adminPermissions: [] as string[] },
  entries: [] as unknown[],
  error: false,
  pending: false,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.identity }) }));
vi.mock('@client/app/hooks/data/adminUserNotes', () => ({
  useAdminUserNotes: () => ({ data: { pages: [{ entries: mocks.entries }] }, isError: mocks.error, refetch: vi.fn() }),
  useWriteAdminUserNote: () => ({ mutateAsync: mocks.write, isPending: mocks.pending }),
  useAdminUserNoteHistory: () => ({
    data: {
      pages: [
        {
          entries: [
            {
              version: 1,
              body: '<b>Original</b>',
              editor: { name: 'Original editor' },
              updatedAt: '2026-10-20T09:00:00Z',
            },
          ],
        },
      ],
    },
  }),
}));
const note = {
  id: 'a'.repeat(24),
  body: '<b>Plain text</b>',
  author: { id: 'admin1', name: 'Test Admin' },
  createdAt: '2026-10-20T09:00:00Z',
  updatedAt: '2026-10-20T09:00:00Z',
  version: 1,
  deleted: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity = { isAdmin: true, adminPermissions: [] };
  mocks.entries = [note];
  mocks.error = false;
  mocks.pending = false;
  mocks.write.mockReset();
  mocks.write.mockResolvedValue({ ...note, version: 2 });
});
const mount = () => render(<UserNotesCard user={buildProfile()} />, { wrapper: ProfileTestWrapper });

describe('UserNotesCard', () => {
  it('renders attributed notes as text, never HTML', () => {
    mount();
    expect(screen.getByTestId('user-notes-list')).toHaveTextContent('<b>Plain text</b>');
    expect(screen.getByTestId('user-note-row')).toHaveTextContent('Test Admin');
    expect(screen.getByTestId('user-note-row').querySelector('b')).toBeNull();
    expect(screen.getByTestId('user-profile-note-input')).toHaveAttribute('maxlength', '2000');
  });
  it('adds notes and offers an audited soft-delete undo', async () => {
    mount();
    fireEvent.change(screen.getByTestId('user-profile-note-input'), { target: { value: 'New context' } });
    fireEvent.click(screen.getByTestId('user-note-add-btn'));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ body: 'New context' }));
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(mocks.write).toHaveBeenLastCalledWith({ noteId: note.id, version: 2, deleted: true }));
  });
  it('edits and deletes with the displayed version', async () => {
    mount();
    fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
    fireEvent.change(screen.getByTestId('user-note-edit-input'), { target: { value: 'Changed context' } });
    fireEvent.click(screen.getByTestId('user-note-save-btn'));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith({ noteId: note.id, version: 1, body: 'Changed context' })
    );
    fireEvent.click(screen.getByTestId(`user-note-delete-${note.id}-btn`));
    await waitFor(() => expect(mocks.write).toHaveBeenLastCalledWith({ noteId: note.id, version: 1, deleted: true }));
  });
  it('hides notes without support read and forbids edit controls for readers', () => {
    mocks.identity = { isAdmin: false, adminPermissions: [] };
    const view = mount();
    expect(screen.queryByTestId('user-notes-list')).not.toBeInTheDocument();
    mocks.identity.adminPermissions = ['support:read'];
    view.rerender(<UserNotesCard user={buildProfile()} />);
    expect(screen.getByTestId('user-notes-list')).toBeInTheDocument();
    expect(screen.queryByTestId('user-note-add-btn')).not.toBeInTheDocument();
  });
  it('preserves a conflicting draft and explains how to restart with the latest version', async () => {
    mocks.write.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    const view = mount();
    fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
    fireEvent.change(screen.getByTestId('user-note-edit-input'), { target: { value: 'My unsaved context' } });
    fireEvent.click(screen.getByTestId('user-note-save-btn'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Copy it before choosing Cancel, then Edit note');
    expect(screen.getByTestId('user-note-edit-input')).toHaveValue('My unsaved context');
    expect(screen.getByTestId('user-note-save-btn')).toBeDisabled();
    mocks.entries = [{ ...note, version: 2, body: 'Another administrator updated this' }];
    view.rerender(<UserNotesCard user={buildProfile()} />);
    expect(screen.getByTestId('user-note-edit-input')).toHaveValue('My unsaved context');

    fireEvent.click(screen.getByTestId('user-note-cancel-btn'));
    fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-note-edit-input')).toHaveValue('Another administrator updated this');
    fireEvent.change(screen.getByTestId('user-note-edit-input'), { target: { value: 'Reviewed combined context' } });
    fireEvent.click(screen.getByTestId('user-note-save-btn'));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenLastCalledWith({ noteId: note.id, version: 2, body: 'Reviewed combined context' })
    );
  });
  it('disables the edit input while saving so subsequent typing cannot be discarded', () => {
    const view = mount();
    fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
    mocks.pending = true;
    view.rerender(<UserNotesCard user={buildProfile()} />);
    expect(screen.getByTestId('user-note-edit-input')).toBeDisabled();
  });
  it.each([true, false])(
    'preserves the draft after remote deletion (save already rejected: %s)',
    async saveRejected => {
      if (saveRejected) mocks.write.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
      const view = mount();
      fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
      fireEvent.change(screen.getByTestId('user-note-edit-input'), { target: { value: 'Draft worth keeping' } });
      if (saveRejected) {
        fireEvent.click(screen.getByTestId('user-note-save-btn'));
        await screen.findByRole('alert');
      }

      mocks.entries = [];
      view.rerender(<UserNotesCard user={buildProfile()} />);
      expect(screen.getByRole('alert')).toHaveTextContent('This note is no longer available');
      expect(screen.getByTestId('user-note-edit-input')).toHaveValue('Draft worth keeping');
      expect(screen.getByTestId('user-note-save-btn')).toBeDisabled();
      expect(screen.queryByTestId(`user-note-edit-${note.id}-btn`)).not.toBeInTheDocument();
      expect(mocks.write).toHaveBeenCalledTimes(saveRejected ? 1 : 0);

      fireEvent.click(screen.getByTestId('user-note-cancel-btn'));
      expect(screen.queryByTestId('user-note-row')).not.toBeInTheDocument();
      expect(screen.queryByTestId('user-note-edit-input')).not.toBeInTheDocument();
      expect(screen.getByText('No internal notes yet.')).toBeInTheDocument();
    }
  );
  it('keeps one note draft while deleting another note', async () => {
    const otherNote = { ...note, id: 'b'.repeat(24), body: 'Other context' };
    mocks.entries = [note, otherNote];
    mount();
    fireEvent.click(screen.getByTestId(`user-note-edit-${note.id}-btn`));
    fireEvent.change(screen.getByTestId('user-note-edit-input'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByTestId(`user-note-delete-${otherNote.id}-btn`));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ noteId: otherNote.id, version: 1, deleted: true }));
    await screen.findByTestId('undo-toast-undo-btn');
    expect(screen.getByTestId('user-note-edit-input')).toHaveValue('Keep my draft');
  });
  it('offers retry instead of silently presenting an empty history', () => {
    mocks.error = true;
    mount();
    expect(screen.getByTestId('user-notes-retry-btn')).toBeInTheDocument();
  });
  it('shows attributed history as plain text', () => {
    mount();
    fireEvent.click(screen.getByTestId(`user-note-history-${note.id}-btn`));
    expect(screen.getByTestId('user-note-history')).toHaveTextContent('Original editor');
    expect(screen.getByTestId('user-note-history')).toHaveTextContent('<b>Original</b>');
    expect(screen.getByTestId('user-note-history').querySelector('b')).toBeNull();
  });
  it('does not carry a draft to another user profile', () => {
    const view = mount();
    fireEvent.change(screen.getByTestId('user-profile-note-input'), { target: { value: 'Context for first user' } });
    view.rerender(<UserNotesCard user={buildProfile({ id: 'another-user' })} />);
    expect(screen.getByTestId('user-profile-note-input')).toHaveValue('');
  });
});
