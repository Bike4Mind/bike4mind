import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SpaceDetail, SpacePerson } from '@client/app/hooks/data/spaces';

vi.mock('@client/app/hooks/data/spaces', () => ({
  useRemoveSpaceMember: () => ({ mutateAsync: vi.fn() }),
  useSetSpaceMemberRole: () => ({ mutate: vi.fn() }),
  useTransferSpaceOwnership: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));

import SpaceMembersTab from './SpaceMembersTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const person = (userId: string, role: SpacePerson['role'], email?: string): SpacePerson => ({
  userId,
  username: `user-${userId}`,
  avatar: null,
  role,
  joinedVia: null,
  joinedAt: null,
  ...(email && { email }),
});

const space = (viewerRole: SpaceDetail['viewerRole'], withEmails: boolean): SpaceDetail => ({
  id: 's1',
  name: 'Guild',
  description: null,
  parentOrganizationId: null,
  viewerRole,
  memberCount: 3,
  owner: person('o', 'owner', withEmails ? 'owner@example.com' : undefined),
  members: [
    person('a', 'admin', withEmails ? 'admin@example.com' : undefined),
    person('m', 'member', withEmails ? 'member@example.com' : undefined),
  ],
});

const renderTab = (detail: SpaceDetail, currentUserId: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SpaceMembersTab space={detail} currentUserId={currentUserId} />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('SpaceMembersTab roster', () => {
  it('never shows an email to a plain member, whose payload carries none', () => {
    renderTab(space('member', false), 'm');
    expect(screen.getByText('user-o')).toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('shows the emails a manager payload carries', () => {
    renderTab(space('admin', true), 'a');
    expect(screen.getByTestId('space-member-email-m')).toHaveTextContent('member@example.com');
    expect(screen.getByTestId('space-member-email-o')).toHaveTextContent('owner@example.com');
  });

  it('lets the owner set roles, transfer to an admin and remove anyone', () => {
    renderTab(space('owner', true), 'o');
    expect(screen.getByTestId('space-member-role-a')).toBeInTheDocument();
    expect(screen.getByTestId('space-member-transfer-a')).toBeInTheDocument();
    expect(screen.queryByTestId('space-member-transfer-m')).not.toBeInTheDocument();
    expect(screen.getByTestId('space-member-remove-a')).toBeInTheDocument();
    expect(screen.getByTestId('space-member-remove-m')).toBeInTheDocument();
  });

  it('lets an admin remove plain members only, with no role or transfer controls', () => {
    renderTab(space('admin', true), 'a');
    expect(screen.getByTestId('space-member-remove-m')).toBeInTheDocument();
    expect(screen.queryByTestId('space-member-remove-o')).not.toBeInTheDocument();
    expect(screen.queryByTestId('space-member-role-m')).not.toBeInTheDocument();
    expect(screen.queryByTestId('space-member-transfer-a')).not.toBeInTheDocument();
  });

  it('offers a plain member no management controls', () => {
    renderTab(space('member', false), 'm');
    expect(screen.queryByTestId('space-member-remove-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('space-member-remove-m')).not.toBeInTheDocument();
  });
});
