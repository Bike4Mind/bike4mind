import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IProjectDocument } from '@bike4mind/common';

type Callback = (type: string, data: unknown) => void;

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return { invalidateQueries, queryClient: { invalidateQueries }, callbacks: {} as Record<string, Callback> };
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
vi.mock('./AddMembersModal', () => ({ default: () => null }));
vi.mock('./UserCard', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));

import ProjectMembersSection from './Members';
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

const fireBurst = () => {
  act(() => {
    ['insert', 'update', 'delete', 'replace', 'insert', 'update', 'delete'].forEach((type, i) =>
      mocks.callbacks.invites(type, { id: `invite-${i}` })
    );
    mocks.callbacks.projects('update', { id: 'project-1' });
  });
};

describe('ProjectMembersSection invite refetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invalidateQueries.mockReset();
    mocks.callbacks = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches project invites once for a burst of invite and project events', () => {
    renderMembers();
    fireBurst();
    expect(projectInviteInvalidations()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(projectInviteInvalidations()).toBe(1);
  });

  it('drops a pending refetch when unmounted mid-burst', () => {
    const { unmount } = renderMembers();
    fireBurst();
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });
});
