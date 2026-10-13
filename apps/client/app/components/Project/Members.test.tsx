import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType, type IProjectDocument } from '@bike4mind/common';

type Callback = (type: string, data: unknown) => void;
type Listener = (type: string, data: { documentId?: string; type?: InviteType }) => void;

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return {
    invalidateQueries,
    queryClient: { invalidateQueries },
    callbacks: {} as Record<string, Callback>,
    subscribeCalls: [] as string[],
    inviteListener: undefined as Listener | undefined,
    enforceCredits: true,
  };
});

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? mocks.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useDeleteInvite: () => ({ mutate: vi.fn() }),
  useGetProjectInvites: () => ({ data: { data: [] } }),
}));
vi.mock('@client/app/hooks/data/projects', () => ({ useLeaveProject: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ data: { users: [] }, isPending: false, refetch: vi.fn() }),
  useUserRevokeSharing: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: (collection: string, _query: unknown, callback: Callback) => {
    mocks.subscribeCalls.push(collection);
    mocks.callbacks[collection] = callback;
  },
}));
// The provider owns the invites subscription; Members registers a listener instead of subscribing.
vi.mock('@client/app/contexts/InboxContext', () => ({
  useInviteEvents: (listener: Listener) => {
    mocks.inviteListener = listener;
  },
}));
vi.mock('./AddMembersModal', () => ({ default: () => null }));
vi.mock('./UserCard', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));

import ProjectMembersSection, { PROJECT_MEMBERS_BILLING_NOTE } from './Members';
import { COALESCED_INVALIDATE_DEBOUNCE_MS } from '@client/app/hooks/useCoalescedInvalidate';

const appTheme = extendTheme({ ...getThemeConfig() });
const project = { id: 'project-1', userId: 'owner-1' } as IProjectDocument;
const renderMembers = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ProjectMembersSection project={project} ownerId="owner-1" />
    </CssVarsProvider>
  );

const projectInviteInvalidations = () =>
  mocks.invalidateQueries.mock.calls.filter(
    ([arg]) => JSON.stringify(arg.queryKey) === JSON.stringify(['invites', 'projects', 'project-1'])
  ).length;

const usersInvalidations = () =>
  mocks.invalidateQueries.mock.calls.filter(([arg]) => (arg.queryKey as unknown[])?.[0] === 'users').length;

const fireProjectInvite = (type: string) =>
  mocks.inviteListener?.(type, { documentId: 'project-1', type: InviteType.Project });

const fireInviteBurst = () =>
  act(() => {
    ['insert', 'update', 'delete', 'replace', 'insert', 'update', 'delete'].forEach(fireProjectInvite);
  });

describe('ProjectMembersSection invite refetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invalidateQueries.mockReset();
    mocks.callbacks = {};
    mocks.subscribeCalls = [];
    mocks.inviteListener = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches project invites once for a burst of invite events', () => {
    renderMembers();
    fireInviteBurst();
    expect(projectInviteInvalidations()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(projectInviteInvalidations()).toBe(1);
  });

  it('refetches project invites when the project itself updates', () => {
    renderMembers();
    act(() => {
      mocks.callbacks.projects('update', { id: 'project-1' });
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(projectInviteInvalidations()).toBe(1);
  });

  it('refetches project invites for a lone replace event', () => {
    renderMembers();
    act(() => {
      fireProjectInvite('replace');
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(projectInviteInvalidations()).toBe(1);
  });

  it('ignores events for another project or another invite type', () => {
    renderMembers();
    const listener = mocks.inviteListener;
    if (!listener) throw new Error('Members did not register an invite listener');
    act(() => {
      listener('insert', { documentId: 'other-project', type: InviteType.Project });
      listener('insert', { documentId: 'project-1', type: InviteType.Organization });
      vi.runAllTimers();
    });
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates the users key once, 500 ms after the last event', () => {
    renderMembers();
    fireInviteBurst();
    act(() => {
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(usersInvalidations()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(usersInvalidations()).toBe(1);
  });

  it('drops a pending refetch when unmounted mid-burst', () => {
    const { unmount } = renderMembers();
    fireInviteBurst();
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it('opens no invites subscription of its own', () => {
    renderMembers();
    expect(mocks.subscribeCalls).not.toContain('invites');
    expect(mocks.subscribeCalls).toContain('projects');
  });
});

describe('ProjectMembersSection billing note', () => {
  beforeEach(() => {
    mocks.enforceCredits = true;
    mocks.callbacks = {};
  });

  it('says who pays for answers when credits are enforced', () => {
    renderMembers();
    expect(screen.getByTestId('project-members-billing-note')).toHaveTextContent(PROJECT_MEMBERS_BILLING_NOTE);
  });

  it('stays out of the way when credits are not enforced', () => {
    mocks.enforceCredits = false;
    renderMembers();
    expect(screen.queryByTestId('project-members-billing-note')).toBeNull();
  });
});
