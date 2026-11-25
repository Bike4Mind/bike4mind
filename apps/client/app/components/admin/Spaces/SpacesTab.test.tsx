// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  useAdminSpaces: vi.fn(),
  useAdminSpace: vi.fn(),
  deleteSpace: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: (opts?: { select?: (s: Record<string, unknown>) => unknown }) =>
    opts?.select ? opts.select(mocks.search) : mocks.search,
}));
vi.mock('@client/app/hooks/data/adminSpaces', () => ({
  useAdminSpaces: mocks.useAdminSpaces,
  useAdminSpace: mocks.useAdminSpace,
  useAdminDeleteSpace: () => ({ mutateAsync: mocks.deleteSpace, isPending: false }),
  useAdminRemoveSpaceMember: () => ({ mutateAsync: mocks.removeMember, isPending: false }),
}));

import SpacesTab from './SpacesTab';

const SPACE_ID = '650000000000000000000aaa';
const OWNER_ID = '650000000000000000000002';
const MEMBER_ID = '650000000000000000000001';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SpacesTab />
    </CssVarsProvider>
  );

const person = (userId: string, role: string, email: string) => ({
  userId,
  role,
  email,
  username: email,
  joinedVia: role === 'owner' ? null : 'invite',
  joinedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = {};
  mocks.useAdminSpaces.mockReturnValue({
    data: {
      total: 1,
      spaces: [
        {
          id: SPACE_ID,
          name: 'Team Space',
          owner: { id: OWNER_ID, username: 'owner', email: 'owner@example.com' },
          memberCount: 2,
          domainCount: 0,
          parentOrganizationId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.useAdminSpace.mockImplementation((id: string | null) => ({
    data: id
      ? {
          space: {
            id,
            name: 'Team Space',
            owner: person(OWNER_ID, 'owner', 'owner@example.com'),
            members: [person(MEMBER_ID, 'member', 'ada@example.com')],
            memberCount: 2,
            parentOrganizationId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          domains: [],
          pendingInviteCount: 0,
        }
      : undefined,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }));
  mocks.navigate.mockResolvedValue(undefined);
});

describe('SpacesTab', () => {
  it('lists Spaces with owner and member count', () => {
    renderTab();
    const row = screen.getByTestId(`admin-space-row-${SPACE_ID}`);
    expect(row.textContent).toContain('Team Space');
    expect(row.textContent).toContain('owner@example.com');
  });

  it('keeps the search text out of the URL', async () => {
    renderTab();
    const input = screen.getByTestId('admin-spaces-search-input');
    fireEvent.change(input, { target: { value: 'ada@example.com' } });
    await waitFor(() =>
      expect(mocks.useAdminSpaces).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'ada@example.com' }))
    );
    for (const [arg] of mocks.navigate.mock.calls) {
      const search = typeof arg.search === 'function' ? arg.search({}) : arg.search;
      expect(JSON.stringify(search)).not.toContain('ada@example.com');
    }
  });
});

describe('SpaceAdminModal', () => {
  beforeEach(() => {
    mocks.search = { spaceId: SPACE_ID };
  });

  it('offers no Remove on the owner row', () => {
    renderTab();
    expect(screen.queryByTestId(`admin-space-member-actions-${OWNER_ID}`)).toBeNull();
    expect(screen.getByTestId(`admin-space-member-actions-${MEMBER_ID}`)).toBeTruthy();
  });

  it('does not delete until the Space name is typed and a reason is given', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-space-header-actions'));
    fireEvent.click(await screen.findByTestId('admin-space-delete-item'));
    const dialog = await screen.findByTestId('admin-space-delete-dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete Space' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(mocks.deleteSpace).not.toHaveBeenCalled();
  });

  it('does not remove a member until a reason is given', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId(`admin-space-member-actions-${MEMBER_ID}`));
    fireEvent.click(await screen.findByTestId(`admin-space-remove-member-${MEMBER_ID}`));
    const dialog = await screen.findByTestId('admin-space-remove-member-dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Remove member' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });
});
