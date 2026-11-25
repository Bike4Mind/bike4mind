import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  inbox: [] as unknown[],
  invites: [] as unknown[],
  useSubscribeCollection: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'member@example.com' } }),
}));
vi.mock('@client/app/hooks/data/inbox', () => ({ useGetInbox: () => ({ data: h.inbox }) }));
vi.mock('@client/app/hooks/data/invites', () => ({ useGetUserInvites: () => ({ data: h.invites }) }));
vi.mock('@client/app/utils/react-query', () => ({ useSubscribeCollection: h.useSubscribeCollection }));

import InboxBadge from './Badge';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBadge = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <InboxBadge>
        <span>avatar</span>
      </InboxBadge>
    </CssVarsProvider>
  );

describe('InboxBadge', () => {
  beforeEach(() => {
    h.inbox = [];
    h.invites = [];
    h.useSubscribeCollection.mockReset();
  });

  it('opens no invites subscription of its own', () => {
    renderBadge();
    renderBadge();
    expect(h.useSubscribeCollection).not.toHaveBeenCalled();
  });

  it('shows the dot for an invite still pending for the current user', () => {
    h.invites = [{ id: 'i1', type: 'Project', remaining: 1, recipients: { pending: ['member@example.com'] } }];
    renderBadge();
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'true');
  });

  it('shows the dot for a pending Space invite', () => {
    h.invites = [{ id: 's1', type: 'Space', remaining: 1, recipients: { pending: ['member@example.com'] } }];
    renderBadge();
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'true');
  });

  it('stays quiet for an invite the list would not show, so badge and list agree', () => {
    h.invites = [
      { id: 'u1', type: 'Space', remaining: 0, recipients: { pending: ['member@example.com'] } },
      { id: 'u2', type: 'Mystery', remaining: 1, recipients: { pending: ['member@example.com'] } },
    ];
    renderBadge();
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'false');
  });

  it('hides the dot when nothing is pending or unread', () => {
    h.invites = [{ id: 'i1', recipients: { pending: ['someone-else@example.com'] } }];
    renderBadge();
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'false');
  });
});
