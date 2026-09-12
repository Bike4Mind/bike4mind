import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type { ReactNode } from 'react';
import { FullUsersView } from './FullUsersView';

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
  useFullUserViewModal: () => vi.fn(),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useDeleteUser: () => ({ mutate: vi.fn() }),
  useUpdateUser: () => ({ mutate: vi.fn(), isPending: false }),
  useLoginAsUser: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: { id: string }; setCurrentUser: () => void }) => unknown) =>
    selector({ currentUser: { id: 'admin-1' }, setCurrentUser: () => {} }),
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
