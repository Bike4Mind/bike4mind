import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import type { ReactNode } from 'react';
import FullUserViewModal, { useFullUserViewModal } from './FullUserViewModal';

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUser: (id: string | null) => ({ isLoading: false, data: id ? { id, name: 'Test User' } : undefined }),
}));

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

const renderOpenModal = () => {
  act(() => useFullUserViewModal.setState({ userId: 'u1' }));
  return render(<FullUserViewModal />, { wrapper: TestWrapper });
};

describe('FullUserViewModal - discard guard', () => {
  beforeEach(() => {
    act(() => {
      useFullUserViewModal.setState({ userId: null });
      useConfirmationModal.setState({ open: false, title: undefined, description: undefined });
    });
  });

  it('closes straight away when nothing is staged', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    expect(useFullUserViewModal.getState().userId).toBeNull();
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
    expect(useFullUserViewModal.getState().userId).toBe('u1');
  });

  it('closes once the discard is confirmed', async () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('stub-stage-edits'));
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    await act(async () => {
      await useConfirmationModal.getState().onOk();
    });

    expect(useFullUserViewModal.getState().userId).toBeNull();
  });

  it('stops guarding once the card reports the edits are gone', () => {
    renderOpenModal();
    fireEvent.click(screen.getByTestId('stub-stage-edits'));
    // A save clears the card's staged state, which it reports straight back up.
    fireEvent.click(screen.getByTestId('stub-clear-edits'));
    fireEvent.click(screen.getByTestId('modal-close-btn'));

    expect(useConfirmationModal.getState().open).toBe(false);
    expect(useFullUserViewModal.getState().userId).toBeNull();
  });
});
