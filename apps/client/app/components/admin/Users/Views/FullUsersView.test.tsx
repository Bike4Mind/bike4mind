import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type { ReactNode } from 'react';
import { FullUsersView } from './FullUsersView';

const mutations = vi.hoisted(() => ({ updateMutate: vi.fn(), loginAsMutate: vi.fn() }));

// Only the Roles column is exercised here (it owns the Custom Tags control that #2441 is
// about), so the card's other sections are stubbed to keep their data hooks out of it.
vi.mock('../../AdminProfile', () => ({ default: () => null }));
vi.mock('../Details/Bike4MindUserDetails', () => ({ default: () => null }));
vi.mock('../Details/LoginDetails', () => ({ default: () => null }));
vi.mock('../Details/UserDetails', () => ({ default: () => null }));
vi.mock('../Details/UserSubscriptionStatus', () => ({ default: () => null }));
vi.mock('../SpicyUserActions', () => ({ default: () => null }));
vi.mock('../ProductAccess', () => ({ default: () => null }));
vi.mock('../SystemMessageModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('../ComplianceModal', () => ({ useComplianceModal: () => vi.fn() }));
vi.mock('@client/app/components/admin/Users/Views/FullUserViewModal', () => ({
  useFullUserViewModal: () => ({ setUserId: vi.fn() }),
}));
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
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

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

describe('FullUsersView - unsaved field reporting', () => {
  it('reports nothing unsaved on a freshly opened card', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(<FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />, {
      wrapper: TestWrapper,
    });
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('reports tags as unsaved once a Custom Tag is staged through the real control', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(<FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />, {
      wrapper: TestWrapper,
    });

    addCustomTag('qa-unsaved-test');

    expect(screen.getByTestId('remove-tag-qa-unsaved-test')).toBeInTheDocument();
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith(['tags']);
  });

  it('goes back to reporting nothing when that tag is removed again', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(<FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />, {
      wrapper: TestWrapper,
    });

    addCustomTag('qa-unsaved-test');
    fireEvent.click(screen.getByTestId('remove-tag-qa-unsaved-test'));

    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('does not re-notify when an edit leaves the same field set unsaved', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(<FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />, {
      wrapper: TestWrapper,
    });

    addCustomTag('first-tag');
    const callsAfterFirstTag = onUnsavedFieldsChange.mock.calls.length;
    addCustomTag('second-tag');

    // Still just 'tags' unsaved, so the host has nothing new to hear about.
    expect(onUnsavedFieldsChange.mock.calls.length).toBe(callsAfterFirstTag);
  });

  it('stops reporting an edit once a fresh server snapshot arrives', () => {
    const onUnsavedFieldsChange = vi.fn();
    const { rerender } = render(
      <FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      { wrapper: TestWrapper }
    );

    addCustomTag('qa-unsaved-test');
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith(['tags']);

    // What Verify Email does: it saves through its own mutation and then syncs the card,
    // so the refetched user lands here and the staged values are replaced wholesale.
    rerender(
      <FullUsersView
        index={0}
        user={{ ...savedUser(), emailVerified: true }}
        inModal
        onUnsavedFieldsChange={onUnsavedFieldsChange}
      />
    );

    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('reports the card as clean when it unmounts, so the host stops guarding', () => {
    const onUnsavedFieldsChange = vi.fn();
    const { unmount } = render(
      <FullUsersView index={0} user={savedUser()} inModal onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      { wrapper: TestWrapper }
    );

    addCustomTag('qa-unsaved-test');
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith(['tags']);

    unmount();
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });
});

describe('FullUsersView - reason-required admin actions', () => {
  beforeEach(() => {
    mutations.updateMutate.mockClear();
    mutations.loginAsMutate.mockClear();
  });

  const typeReason = (testId: string, value: string) =>
    fireEvent.change(screen.getByTestId(testId), { target: { value } });

  it('requires a reason before a role change is saved, then sends roleChangeReason', () => {
    render(<FullUsersView index={0} user={savedUser()} inModal />, { wrapper: TestWrapper });

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

    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0]).toMatchObject({
      id: 'u1',
      data: { isAdmin: true, roleChangeReason: 'Promoted to cover on-call' },
    });
  });

  it('saves without a confirm dialog or roleChangeReason when the role is untouched', () => {
    render(<FullUsersView index={0} user={savedUser()} inModal />, { wrapper: TestWrapper });

    addCustomTag('plain-tag');
    fireEvent.click(screen.getByTestId('user-update-btn'));

    expect(screen.queryByTestId('role-change-reason-input')).not.toBeInTheDocument();
    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0].data).not.toHaveProperty('roleChangeReason');
  });

  it('login-as sends the reason with the MFA token and blocks confirm until it is valid', () => {
    render(<FullUsersView index={0} user={savedUser()} inModal />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('login-as-user-btn'));
    fireEvent.change(screen.getByTestId('login-as-mfa-input').querySelector('input') as HTMLInputElement, {
      target: { value: '123456' },
    });
    const confirmButton = screen.getByTestId('login-as-mfa-confirm-btn');
    expect(confirmButton).toBeDisabled();

    typeReason('login-as-reason-input', 'Reproduce billing bug');
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(mutations.loginAsMutate).toHaveBeenCalledWith({
      id: 'u1',
      mfaToken: '123456',
      reason: 'Reproduce billing bug',
    });
  });
});
