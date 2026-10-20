import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const KNOWN_USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MISSING_USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FAILING_USER_ID = 'cccccccccccccccccccccccc';
const axiosError = (status: number) => ({ isAxiosError: true, response: { status } });
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUser: (id: string | null) => ({
    isLoading: false,
    isFetching: false,
    isError: !!id && id !== KNOWN_USER_ID,
    error: id === MISSING_USER_ID ? axiosError(404) : id === FAILING_USER_ID ? axiosError(500) : null,
    data: id === KNOWN_USER_ID ? { id, name: 'Test User' } : undefined,
  }),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import FullUserViewModal from './FullUserViewModal';

// The card under test here is the modal's close guard, not the card itself; the stub
// stands in for an admin staging an edit inside it.
vi.mock('@client/app/components/admin/Users/Views/FullUsersView', () => ({
  FullUsersView: ({ onUnsavedFieldsChange }: { onUnsavedFieldsChange?: (fieldKeys: string[]) => void }) => (
    <>
      <button data-testid="stub-stage-edits" onClick={() => onUnsavedFieldsChange?.(['tags', 'currentCredits'])}>
        stage edits
      </button>
      <button data-testid="stub-clear-edits" onClick={() => onUnsavedFieldsChange?.([])}>
        clear edits
      </button>
    </>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const openUserId = () => fakeAdminRouter.search.userId ?? null;

const renderOpenModal = (userId = KNOWN_USER_ID) => {
  act(() => fakeAdminRouter.reset({ tab: 'users', page: 1, userId }));
  return render(<FullUserViewModal />, { wrapper: TestWrapper });
};

beforeEach(() => {
  toastError.mockClear();
  act(() => {
    fakeAdminRouter.reset();
    useConfirmationModal.setState({ open: false, title: undefined, description: undefined });
  });
});

describe('FullUserViewModal - URL', () => {
  it('opens the user named by ?userId= on load', () => {
    renderOpenModal();

    expect(screen.getByTestId('full-user-view-modal')).toBeInTheDocument();
  });

  it('stays closed without ?userId=', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 1 }));
    render(<FullUserViewModal />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('full-user-view-modal')).not.toBeInTheDocument();
  });

  it('removes only ?userId= from the URL on close', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'users', page: 1 });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('closes and says so when the id matches no user', () => {
    renderOpenModal(MISSING_USER_ID);

    expect(openUserId()).toBeNull();
    expect(screen.queryByTestId('full-user-view-modal')).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith('That user could not be found.', expect.anything());
  });

  it('stays open on a server error, which says nothing about the user existing', () => {
    renderOpenModal(FAILING_USER_ID);

    expect(openUserId()).toBe(FAILING_USER_ID);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('FullUserViewModal - discard guard', () => {
  it('closes straight away when nothing is staged', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    expect(openUserId()).toBeNull();
    expect(useConfirmationModal.getState().open).toBe(false);
  });

  it('asks before discarding, and names every unsaved field', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('stub-stage-edits'));
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    const confirmation = useConfirmationModal.getState();
    expect(confirmation.open).toBe(true);
    expect(confirmation.title).toBe('Discard changes?');
    expect(confirmation.description).toContain('Tags and product access, Credits');
    expect(confirmation.okLabel).toBe('Discard changes');
    expect(confirmation.cancelLabel).toBe('Keep editing');
    // Still open: the edits are only lost once the admin confirms.
    expect(openUserId()).toBe(KNOWN_USER_ID);
  });

  it('closes once the discard is confirmed', async () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('stub-stage-edits'));
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    await act(async () => {
      await useConfirmationModal.getState().onOk();
    });

    expect(openUserId()).toBeNull();
  });

  it('stops guarding once the card reports the edits are gone', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('stub-stage-edits'));
    // A save clears the card's staged state, which it reports straight back up.
    fireEvent.click(screen.getByTestId('stub-clear-edits'));
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    expect(useConfirmationModal.getState().open).toBe(false);
    expect(openUserId()).toBeNull();
  });
});
