import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminProfileModal, { useAdminProfileModal } from './AdminProfileModal';
import SystemMessageModal from './Users/SystemMessageModal';

const state = vi.hoisted(() => ({
  currentUser: { isAdmin: false, adminPermissions: ['settings:manage'] },
  send: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUser: () => ({ isLoading: false, data: { id: 'target' } }) }));
vi.mock('@client/app/components/ProfileModal/ProfileDataForm', () => ({
  default: () => <div data-testid="admin-profile-editor-content" />,
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/inbox', () => ({
  useSendSystemMessage: () => ({ mutate: state.send, isPending: false }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));
const theme = extendTheme({ ...getThemeConfig() });
const renderDialogs = () =>
  render(
    <>
      <AdminProfileModal />
      <SystemMessageModal open onClose={vi.fn()} receiverId="target" />
    </>,
    { wrapper: ({ children }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider> }
  );

describe('open administrative dialogs after permission revocation', () => {
  it('hides profile and message editors when settings access is revoked', () => {
    state.currentUser.adminPermissions = ['settings:manage'];
    useAdminProfileModal.setState({ userId: 'target' });
    const view = renderDialogs();
    expect(screen.getByTestId('admin-profile-editor-content')).toBeInTheDocument();
    const messageInput = screen.getByPlaceholderText('Message Title');
    const savedForm = messageInput.closest('form')!;
    fireEvent.change(messageInput, { target: { value: 'System notice' } });
    state.currentUser.adminPermissions = [];
    view.rerender(
      <>
        <AdminProfileModal />
        <SystemMessageModal open onClose={vi.fn()} receiverId="target" />
      </>
    );
    expect(screen.queryByTestId('admin-profile-editor-content')).toBeNull();
    expect(screen.queryByPlaceholderText('Message Title')).toBeNull();
    fireEvent.submit(savedForm);
    expect(state.send).not.toHaveBeenCalled();
  });
});
