import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteType } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  invites: [] as Array<Record<string, unknown>>,
  accept: vi.fn(),
  refuse: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'me@example.com' } }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useGetUserInvites: () => ({ data: mocks.invites }),
  useAcceptDocument: () => ({ mutate: mocks.accept, isPending: false }),
  useRefuseDocument: () => ({ mutate: mocks.refuse, isPending: false }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries: vi.fn() }) }));

import PendingProjectInvites, { selectPendingProjectInvites } from './PendingInvites';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PendingProjectInvites />
    </CssVarsProvider>
  );

const projectInvite = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  type: InviteType.Project,
  name: 'Launch plan',
  username: 'alex',
  remaining: 1,
  recipients: { pending: ['me@example.com'] },
  ...overrides,
});

describe('PendingProjectInvites', () => {
  beforeEach(() => {
    mocks.accept.mockReset();
    mocks.refuse.mockReset();
    mocks.invites = [];
  });

  it('renders nothing without a pending project invite', () => {
    mocks.invites = [projectInvite({ type: InviteType.Session })];
    renderWithTheme();
    expect(screen.queryByTestId('projects-pending-invites')).toBeNull();
  });

  it('lists a pending project invite and accepts it inline', () => {
    mocks.invites = [projectInvite()];
    renderWithTheme();

    expect(screen.getByText('Launch plan')).toBeTruthy();
    fireEvent.click(screen.getByTestId('projects-pending-invite-accept-btn'));
    expect(mocks.accept).toHaveBeenCalledWith('inv-1');
    expect(screen.queryByTestId('projects-pending-invite')).toBeNull();
  });

  it('declines a pending project invite inline', () => {
    mocks.invites = [projectInvite()];
    renderWithTheme();

    fireEvent.click(screen.getByTestId('projects-pending-invite-decline-btn'));
    expect(mocks.refuse).toHaveBeenCalledWith('inv-1');
  });

  it('ignores used-up invites and invites addressed to someone else', () => {
    const pending = selectPendingProjectInvites(
      [
        projectInvite({ id: 'a' }),
        projectInvite({ id: 'b', remaining: 0 }),
        projectInvite({ id: 'c', recipients: { pending: ['other@example.com'] } }),
      ] as never,
      'me@example.com'
    );
    expect(pending.map(i => i.id)).toEqual(['a']);
  });

  it('matches the pending address case-insensitively, as the inbox query does', () => {
    const pending = selectPendingProjectInvites([projectInvite()] as never, 'Me@Example.com');
    expect(pending.map(i => i.id)).toEqual(['inv-1']);
  });
});
