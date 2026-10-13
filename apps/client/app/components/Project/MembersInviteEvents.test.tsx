import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType, type IProjectDocument } from '@bike4mind/common';

// Renders the real InboxProvider around ProjectMembersSection, so the invites fan-out seam between
// them is exercised end to end (Members.test.tsx and InboxContext.test.tsx each mock one side).

type Callback = (type: string, data: unknown) => void;

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return {
    invalidateQueries,
    queryClient: { invalidateQueries },
    callbacks: {} as Record<string, Callback>,
  };
});

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
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
    mocks.callbacks[collection] = callback;
  },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: { id: 'user-1' } }),
}));
vi.mock('@client/app/components/inbox/Modal', () => ({ default: () => null }));
vi.mock('./AddMembersModal', () => ({ default: () => null }));
vi.mock('./UserCard', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));

import ProjectMembersSection from './Members';
import { InboxProvider } from '@client/app/contexts/InboxContext';

const appTheme = extendTheme({ ...getThemeConfig() });
const project = { id: 'seam-project', userId: 'owner-1' } as IProjectDocument;

const projectInviteInvalidations = () =>
  mocks.invalidateQueries.mock.calls.filter(
    ([arg]) => JSON.stringify(arg.queryKey) === JSON.stringify(['invites', 'projects', 'seam-project'])
  ).length;

describe('InboxProvider -> ProjectMembersSection invite events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invalidateQueries.mockReset();
    mocks.callbacks = {};
    render(
      <CssVarsProvider theme={appTheme}>
        <InboxProvider>
          <ProjectMembersSection project={project} ownerId="owner-1" />
        </InboxProvider>
      </CssVarsProvider>
    );
    // Settle the rescope the Members mount triggers, so only the event under test is counted.
    act(() => {
      vi.runAllTimers();
    });
    mocks.invalidateQueries.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches the project's invites when the provider's subscription delivers one of them", () => {
    act(() => {
      mocks.callbacks.invites('insert', { id: 'invite-1', documentId: 'seam-project', type: InviteType.Project });
      vi.runAllTimers();
    });

    expect(projectInviteInvalidations()).toBe(1);
  });

  it("leaves the project's invites alone for another project's invite", () => {
    act(() => {
      mocks.callbacks.invites('insert', { id: 'invite-2', documentId: 'other-project', type: InviteType.Project });
      vi.runAllTimers();
    });

    expect(projectInviteInvalidations()).toBe(0);
  });
});
