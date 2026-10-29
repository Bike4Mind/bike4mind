import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type { ReactNode } from 'react';
import { FullUsersView } from './FullUsersView';

const mutations = vi.hoisted(() => ({ updateMutate: vi.fn(), loginAsMutate: vi.fn(), navigate: vi.fn() }));

// Only the Roles column is exercised here (it owns the Custom Tags control that #2441 is
// about), so the card's other sections are stubbed to keep their data hooks out of it.
vi.mock('../../AdminProfile', () => ({ default: () => null }));
vi.mock('../Details/Bike4MindUserDetails', () => ({ default: () => null }));
vi.mock('../Details/LoginDetails', () => ({ default: () => null }));
vi.mock('../Details/UserDetails', () => ({ default: () => null }));
vi.mock('../Details/UserSubscriptionStatus', () => ({ default: () => null }));
// Stands in for the Ban checkbox: the same call the real control makes.
vi.mock('../SpicyUserActions', () => ({
  default: ({ onFieldChange }: { onFieldChange: (key: string, value: unknown) => void }) => (
    <button data-testid="stub-ban-toggle" onClick={() => onFieldChange('isBanned', true)} />
  ),
}));
vi.mock('../ProductAccess', () => ({ default: () => null }));
vi.mock('../SystemMessageModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('../ComplianceModal', () => ({ useComplianceModal: () => vi.fn() }));
// The real panel is lazy-loaded; stub it so the tab wiring is what this file exercises.
vi.mock('../Activity/UserActivityPanel', () => ({ default: () => <div data-testid="user-activity-panel" /> }));
vi.mock('@client/app/hooks/data/user', () => ({
  useDeleteUser: () => ({ mutate: vi.fn() }),
  useUpdateUser: () => ({ mutate: mutations.updateMutate, isPending: false }),
  useLoginAsUser: () => ({ mutate: mutations.loginAsMutate, isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (
    selector: (state: {
      currentUser: { id: string; mfa: { totpEnabled: boolean } };
      setCurrentUser: () => void;
    }) => unknown
  ) => selector({ currentUser: { id: 'admin-1', mfa: { totpEnabled: true } }, setCurrentUser: () => {} }),
}));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ settings: {} }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mutations.navigate }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const savedUser = () =>
  ({
    id: 'u1',
    name: 'Ada',
    username: 'ada',
    email: 'ada@example.com',
    isAdmin: false,
    tags: ['research'],
    level: 'DemoUser',
  }) as AdminUserListItem;

const addCustomTag = (tag: string) => {
  fireEvent.change(screen.getByPlaceholderText('Input a custom tag'), { target: { value: tag } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};

describe('FullUsersView - Overview and Activity tabs', () => {
  it('keeps staged Overview edits when switching to Activity and back', async () => {
    render(<FullUsersView index={0} user={savedUser()} />, {
      wrapper: TestWrapper,
    });

    addCustomTag('qa-tab-switch');

    fireEvent.click(screen.getByTestId('user-profile-tab-activity'));
    expect(await screen.findByTestId('user-activity-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-profile-tab-overview'));
    expect(screen.getByTestId('remove-tag-qa-tab-switch')).toBeInTheDocument();
  });
});

describe('FullUsersView - reason-required admin actions', () => {
  beforeEach(() => {
    mutations.updateMutate.mockClear();
    mutations.loginAsMutate.mockClear();
  });

  const typeReason = (testId: string, value: string) =>
    fireEvent.change(screen.getByTestId(testId), { target: { value } });

  it('requires a reason before a role change is saved, then sends roleChangeReason', async () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('role-radio-super-admin').querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByTestId('user-update-btn'));

    // Confirm dialog opens instead of saving straight away.
    expect(mutations.updateMutate).not.toHaveBeenCalled();
    const confirmButton = screen.getByTestId('role-change-confirm-btn');
    expect(confirmButton).toBeDisabled();

    typeReason('role-change-reason-input', 'no');
    expect(confirmButton).toBeDisabled();

    typeReason('role-change-reason-input', '  Promoted to cover on-call  ');
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mutations.updateMutate).toHaveBeenCalledTimes(1));
    expect(mutations.updateMutate.mock.calls[0][0]).toMatchObject({
      id: 'u1',
      data: { isAdmin: true, roleChangeReason: 'Promoted to cover on-call' },
    });
  });

  it('saves without a confirm dialog or roleChangeReason when the role is untouched', () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    addCustomTag('plain-tag');
    fireEvent.click(screen.getByTestId('user-update-btn'));

    expect(screen.queryByTestId('role-change-reason-input')).not.toBeInTheDocument();
    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0].data).not.toHaveProperty('roleChangeReason');
  });

  it('login-as sends the reason with the MFA token and blocks confirm until it is valid', async () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('login-as-user-btn'));
    fireEvent.change(screen.getByTestId('login-as-mfa-input').querySelector('input') as HTMLInputElement, {
      target: { value: '123456' },
    });
    const confirmButton = screen.getByTestId('login-as-mfa-confirm-btn');
    expect(confirmButton).toBeDisabled();

    typeReason('login-as-reason-input', 'Reproduce billing bug');
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mutations.loginAsMutate).toHaveBeenCalledWith({
        id: 'u1',
        mfaToken: '123456',
        reason: 'Reproduce billing bug',
      })
    );
  });
});

describe('FullUsersView - ban confirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  const typeReason = (testId: string, value: string) =>
    fireEvent.change(screen.getByTestId(testId), { target: { value } });

  it('holds a staged ban until a reason is given, then saves it as statusChangeReason', () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('stub-ban-toggle'));
    fireEvent.click(screen.getByTestId('user-update-btn'));

    expect(mutations.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('user-profile-danger-confirm-modal')).toHaveTextContent('You are about to ban Ada');
    expect(screen.getByTestId('user-profile-danger-confirm-btn')).toBeDisabled();

    typeReason('user-profile-danger-confirm-modal-reason-input', 'Repeated abuse reports');
    fireEvent.click(screen.getByTestId('user-profile-danger-confirm-btn'));

    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0]).toMatchObject({
      id: 'u1',
      data: { isBanned: true, statusChangeReason: 'Repeated abuse reports' },
    });
  });

  it('keeps the status reason through the role step that follows', () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('stub-ban-toggle'));
    fireEvent.click(screen.getByTestId('role-radio-super-admin').querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByTestId('user-update-btn'));
    typeReason('user-profile-danger-confirm-modal-reason-input', 'Repeated abuse reports');
    fireEvent.click(screen.getByTestId('user-profile-danger-confirm-btn'));

    expect(mutations.updateMutate).not.toHaveBeenCalled();
    typeReason('role-change-reason-input', 'Promoted to cover on-call');
    fireEvent.click(screen.getByTestId('role-change-confirm-btn'));

    expect(mutations.updateMutate.mock.calls[0][0].data).toMatchObject({
      isBanned: true,
      statusChangeReason: 'Repeated abuse reports',
      roleChangeReason: 'Promoted to cover on-call',
    });
  });
});

describe('FullUsersView - card in the Users list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers Overview and Activity only, and links to the full profile', () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('user-profile-tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-tab-activity')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-tab-admin')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-card-open-profile-btn'));
    expect(mutations.navigate).toHaveBeenCalledWith({ to: '/admin/users/$userId', params: { userId: 'u1' } });
  });

  it('will not leave for the profile while the card holds staged edits', () => {
    render(<FullUsersView index={0} user={savedUser()} />, { wrapper: TestWrapper });

    addCustomTag('unsaved-tag');

    expect(screen.getByTestId('user-card-open-profile-btn')).toBeDisabled();
  });
});
