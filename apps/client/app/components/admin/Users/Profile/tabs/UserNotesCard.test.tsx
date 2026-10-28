import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';
import { UserNotesCard } from './UserNotesCard';

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  identity: { isAdmin: true, adminPermissions: [] as string[] },
  entries: [] as unknown[],
  error: false,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.identity }) }));
vi.mock('@client/app/hooks/data/adminUserNotes', () => ({
  useAdminUserNotes: () => ({ data: { pages: [{ entries: mocks.entries }] }, isError: mocks.error, refetch: vi.fn() }),
  useWriteAdminUserNote: () => ({ mutateAsync: mocks.write, isPending: false }),
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
});
