import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ enforceCredits: true, invites: [] as unknown[] }));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? h.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useGetUserInvites: () => ({ data: h.invites, isFetching: false }),
  useAcceptDocument: () => ({ mutate: vi.fn() }),
  useRefuseDocument: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'member@example.com' } }),
}));

import Invites, { SHARED_USAGE_BILLING_NOTE } from './Invites';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderInvites = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <Invites />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const invite = (id: string, type: string) => ({
  id,
  type,
  name: `${type} doc`,
  username: 'owner',
  remaining: 1,
  recipients: { pending: ['member@example.com'] },
});

describe('Invites billing note', () => {
  beforeEach(() => {
    h.enforceCredits = true;
    h.invites = [invite('p1', 'Project'), invite('f1', 'FabFile')];
  });

  it('tells a project invitee that usage is billed to their own credits', () => {
    renderInvites();
    const notes = screen.getAllByTestId('invite-billing-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(SHARED_USAGE_BILLING_NOTE);
  });

  it('omits the note while credits are not enforced', () => {
    h.enforceCredits = false;
    renderInvites();
    expect(screen.queryByTestId('invite-billing-note')).not.toBeInTheDocument();
  });
});
