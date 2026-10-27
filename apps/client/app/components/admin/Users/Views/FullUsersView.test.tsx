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
vi.mock('../Details/Bike4MindUserDetails', () => ({
  default: () => <input data-testid="admin-user-credits-input" data-admin-credits-input />,
}));
vi.mock('../BulkAbuseResponseModal', () => ({
  default: ({ selectedUserIds, recordAction }: { selectedUserIds: string[]; recordAction: string }) => (
    <div data-testid="profile-action-preview" data-user={selectedUserIds[0]} data-action={recordAction} />
  ),
}));
vi.mock('../Details/LoginDetails', () => ({ default: () => null }));
vi.mock('../Details/UserDetails', () => ({ default: () => null }));
vi.mock('../Details/UserSubscriptionStatus', () => ({ default: () => null }));
// Stands in for the Ban checkbox and the confirmed Delete: the same calls the real controls make.
vi.mock('../SpicyUserActions', () => ({
  default: ({
    onFieldChange,
    handleDeleteUser,
  }: {
    onFieldChange: (key: string, value: unknown) => void;
    handleDeleteUser: (userId: string, reason: string) => Promise<void>;
  }) => (
    <>
      <button data-testid="stub-ban-toggle" onClick={() => onFieldChange('isBanned', true)} />
      <button data-testid="stub-delete" onClick={() => handleDeleteUser('u1', 'Spam account')} />
    </>
  ),
}));
vi.mock('../Details/GrantSubscriptionModal', () => ({ default: () => null }));
vi.mock('../ProductAccess', () => ({ default: () => null }));
vi.mock('../SystemMessageModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('../ComplianceModal', () => ({ useComplianceModal: () => vi.fn() }));
// The real panel is lazy-loaded; stub it so the tab wiring is what this file exercises.
vi.mock('../Activity/UserActivityPanel', () => ({ default: () => <div data-testid="user-activity-panel" /> }));
vi.mock('@client/app/hooks/data/user', () => ({
  // Succeeds at once, so the caller's per-call onSuccess is what the delete tests observe.
  useDeleteUser: () => ({
    mutate: (_variables: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.(),
  }),
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
  it('focuses credits with c and opens a current-user suspension preview with s without writing', () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('user-profile-tab-activity'));
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(screen.getByTestId('admin-user-credits-input')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('admin-user-credits-input'), { key: 's' });
    expect(screen.queryByTestId('profile-action-preview')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 's' });
    expect(screen.getByTestId('profile-action-preview')).toHaveAttribute('data-user', 'u1');
    expect(screen.getByTestId('profile-action-preview')).toHaveAttribute('data-action', 'suspend');
    expect(mutations.updateMutate).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'suspend', label: 'Suspend account' },
    { action: 'revoke', label: 'Revoke API keys' },
  ])('protects staged edits from the $action command until they are undone', ({ action, label }) => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });
    addCustomTag('unsaved-record-action');

    expect(screen.getByTestId(`admin-command-${action}-btn`)).toBeDisabled();
    expect(screen.getByTestId('profile-action-unsaved-hint')).toHaveTextContent('Update or undo your changes');
    fireEvent.click(screen.getByTestId(`admin-command-${action}-btn`));
    fireEvent.keyDown(document.body, { key: 's' });
    expect(screen.queryByTestId('profile-action-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('remove-tag-unsaved-record-action')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    const search = screen.getByTestId('admin-search-input');
    fireEvent.change(search, { target: { value: label } });
    expect(screen.getByTestId('admin-search-result')).toBeDisabled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.queryByTestId('profile-action-preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-command-close-btn'));

    fireEvent.click(screen.getByTestId('remove-tag-unsaved-record-action'));
    expect(screen.getByTestId(`admin-command-${action}-btn`)).toBeEnabled();
    expect(screen.queryByTestId('profile-action-unsaved-hint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`admin-command-${action}-btn`));
    expect(screen.getByTestId('profile-action-preview')).toHaveAttribute('data-action', action);
  });

  it('keeps staged Overview edits when switching to Activity and back', async () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    addCustomTag('qa-tab-switch');

    fireEvent.click(screen.getByTestId('user-profile-tab-activity'));
    expect(await screen.findByTestId('user-activity-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-profile-tab-overview'));
    expect(screen.getByTestId('remove-tag-qa-tab-switch')).toBeInTheDocument();
  });
});

describe('FullUsersView - unsaved field reporting', () => {
  it('reports nothing unsaved on a freshly opened card', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      {
        wrapper: TestWrapper,
      }
    );
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('reports tags as unsaved once a Custom Tag is staged through the real control', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      {
        wrapper: TestWrapper,
      }
    );

    addCustomTag('qa-unsaved-test');

    expect(screen.getByTestId('remove-tag-qa-unsaved-test')).toBeInTheDocument();
    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith(['tags']);
  });

  it('goes back to reporting nothing when that tag is removed again', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      {
        wrapper: TestWrapper,
      }
    );

    addCustomTag('qa-unsaved-test');
    fireEvent.click(screen.getByTestId('remove-tag-qa-unsaved-test'));

    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('does not re-notify when an edit leaves the same field set unsaved', () => {
    const onUnsavedFieldsChange = vi.fn();
    render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
      {
        wrapper: TestWrapper,
      }
    );

    addCustomTag('first-tag');
    const callsAfterFirstTag = onUnsavedFieldsChange.mock.calls.length;
    addCustomTag('second-tag');

    // Still just 'tags' unsaved, so the host has nothing new to hear about.
    expect(onUnsavedFieldsChange.mock.calls.length).toBe(callsAfterFirstTag);
  });

  it('stops reporting an edit once a fresh server snapshot arrives', () => {
    const onUnsavedFieldsChange = vi.fn();
    const { rerender } = render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
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
        variant="page"
        onUnsavedFieldsChange={onUnsavedFieldsChange}
      />
    );

    expect(onUnsavedFieldsChange).toHaveBeenLastCalledWith([]);
  });

  it('reports the card as clean when it unmounts, so the host stops guarding', () => {
    const onUnsavedFieldsChange = vi.fn();
    const { unmount } = render(
      <FullUsersView index={0} user={savedUser()} variant="page" onUnsavedFieldsChange={onUnsavedFieldsChange} />,
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

  it('requires a reason before a role change is saved, then sends roleChangeReason', async () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

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
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

    addCustomTag('plain-tag');
    fireEvent.click(screen.getByTestId('user-update-btn'));

    expect(screen.queryByTestId('role-change-reason-input')).not.toBeInTheDocument();
    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0].data).not.toHaveProperty('roleChangeReason');
  });

  it('login-as sends the reason with the MFA token and blocks confirm until it is valid', async () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

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

describe('FullUsersView - page danger zone', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the destructive actions on the Admin tab, out of the Overview', () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

    expect(screen.getByTestId('user-profile-danger-zone')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('user-profile-tab-admin'));
    expect(screen.getByTestId('user-profile-danger-zone')).toBeVisible();
  });

  it('gives the header quick actions accessible names', () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

    expect(screen.getByRole('button', { name: 'Login as User' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant Subscription' })).toBeInTheDocument();
  });

  it('opens on the tab its host passes, so ?tab=admin deep-links the danger zone', () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" tab="admin" onTabChange={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByTestId('user-profile-danger-zone')).toBeVisible();
    expect(screen.getByTestId('user-profile-tab-admin')).toHaveAttribute('aria-selected', 'true');
  });

  it('tells its host once the user is deleted', () => {
    const onUserDeleted = vi.fn();
    render(<FullUsersView index={0} user={savedUser()} variant="page" onUserDeleted={onUserDeleted} />, {
      wrapper: TestWrapper,
    });

    fireEvent.click(screen.getByTestId('stub-delete'));

    expect(onUserDeleted).toHaveBeenCalledTimes(1);
  });

  it('confirms a staged ban before saving it', () => {
    render(<FullUsersView index={0} user={savedUser()} variant="page" />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('stub-ban-toggle'));
    fireEvent.click(screen.getByTestId('user-update-btn'));

    expect(mutations.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('user-profile-danger-confirm-modal')).toHaveTextContent('You are about to ban Ada');

    fireEvent.click(screen.getByTestId('user-profile-danger-confirm-btn'));

    expect(mutations.updateMutate).toHaveBeenCalledTimes(1);
    expect(mutations.updateMutate.mock.calls[0][0]).toMatchObject({ id: 'u1', data: { isBanned: true } });
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
