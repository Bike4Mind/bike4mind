import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument } from '@bike4mind/common';
import i18next from 'i18next';
import en from '@client/app/locales/en.json';
import MemberRoster from './MemberRoster';
import type { OrganizationRosterRow } from './UserCard';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  removeMember: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => mocks.confirm }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useRemoveMemberFromOrganization: () => ({ mutateAsync: mocks.removeMember }),
  removedMembersMessage: (kept: unknown[]) => `removed ${kept.length}`,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
// A real i18next over en.json, so the role filter options are the labels users see.
const i18n = vi.hoisted(() => ({ t: (key: string): string => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: i18n.t }) }));
const i18nInstance = i18next.createInstance();
void i18nInstance.init({ lng: 'en', resources: { en: { translation: en } }, initAsync: false });
i18n.t = i18nInstance.t.bind(i18nInstance) as (key: string) => string;
vi.mock('./UserCard', () => ({
  default: (p: {
    user: OrganizationRosterRow;
    canRevokeMembers: boolean;
    selectable: boolean;
    selected: boolean;
    onToggleSelect?: () => void;
  }) => (
    <div
      data-testid="roster-row"
      data-user-id={p.user.id}
      data-revoke={String(p.canRevokeMembers)}
      data-selectable={String(p.selectable)}
    >
      {p.user.name}
      {p.onToggleSelect && (
        <input type="checkbox" aria-label={`Select ${p.user.name}`} checked={p.selected} onChange={p.onToggleSelect} />
      )}
    </div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const organization = { id: 'org1', userId: 'owner' } as unknown as IOrganizationDocument;

const row = (overrides: Partial<OrganizationRosterRow> & { id: string }) =>
  ({
    name: overrides.id,
    email: `${overrides.id}@example.test`,
    status: 'accepted',
    role: 'member',
    permissions: [],
    creditUsage: null,
    ...overrides,
  }) as OrganizationRosterRow;

const usage = (used: number) => ({ tracked: true, used, cap: null, isOverride: false });

const roster = [
  row({ id: 'owner', name: 'Olive Owner', role: 'owner', creditUsage: usage(10) }),
  row({ id: 'me', name: 'Mia Self', role: 'manager', creditUsage: usage(1) }),
  row({ id: 'ada', name: 'Ada Adams', email: 'ada@math.test', creditUsage: usage(30) }),
  row({ id: 'bob', name: 'Bob Brown', creditUsage: usage(20) }),
  row({ id: 'mgr', name: 'Max Manager', role: 'manager', creditUsage: usage(5) }),
  row({ id: 'pat', name: 'Pat Pending', status: 'pending' }),
];

type Props = Partial<Parameters<typeof MemberRoster>[0]>;
const renderRoster = (props: Props = {}) => {
  const onRetry = vi.fn();
  const utils = render(
    <MemberRoster
      organization={organization}
      members={roster}
      isLoading={false}
      isError={false}
      onRetry={onRetry}
      currentUserId="me"
      canInviteMembers
      canRevokeMembers
      canRevokeMember={id => id !== 'mgr'}
      canManageCreditBudgets
      canManageManagers={false}
      {...props}
    />,
    { wrapper: Wrapper }
  );
  return { ...utils, onRetry };
};

const shownIds = () => screen.queryAllByTestId('roster-row').map(el => el.getAttribute('data-user-id'));

const choose = async (selectTestId: string, option: string) => {
  await userEvent.click(screen.getByTestId(selectTestId));
  await userEvent.click(screen.getByRole('option', { name: option }));
};

type ConfirmArgs = { title: string; description: ReactNode; type: string; okLabel: string; onOk: () => Promise<void> };
const lastConfirm = () => mocks.confirm.mock.calls.at(-1)?.[0] as ConfirmArgs;

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.removeMember.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

describe('MemberRoster list states', () => {
  it('shows a labelled loading state and no pagination', () => {
    renderRoster({ isLoading: true });
    expect(screen.getByTestId('organization-members-loading')).toHaveAttribute('aria-label', 'Loading members');
    expect(screen.queryByTestId('organization-members-page-range')).toBeNull();
  });

  it('shows an error with a retry', () => {
    const { onRetry } = renderRoster({ isError: true });
    fireEvent.click(screen.getByTestId('organization-members-retry-btn'));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByTestId('organization-members-page-range')).toBeNull();
  });

  it('shows an empty team', () => {
    renderRoster({ members: [] });
    expect(screen.getByTestId('organization-members-empty')).toBeTruthy();
    expect(screen.getByTestId('organization-members-select-all')).toBeDisabled();
  });

  it('shows a no-match state whose Clear filters restores the full list', async () => {
    renderRoster();
    const search = screen.getByTestId('organization-members-search-input');
    fireEvent.change(search, { target: { value: 'nobody' } });
    await waitFor(() => expect(screen.getByTestId('organization-members-no-match')).toBeTruthy());
    expect(screen.queryByTestId('organization-members-page-range')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-members-clear-filters-btn'));
    expect(search).toHaveValue('');
    expect(shownIds()).toHaveLength(roster.length);
  });
});

describe('MemberRoster header and controls', () => {
  it('labels every column, including a screen-reader-only Actions column', () => {
    renderRoster();
    const header = screen.getByTestId('organization-members-list-header');
    for (const label of ['Name', 'Email', 'Role', 'Credits this month', 'Last active', 'Actions']) {
      expect(within(header).getByText(label)).toBeTruthy();
    }
  });

  it('gives every control an accessible name', () => {
    renderRoster();
    for (const name of [
      'Search members by name or email',
      'Select all members on this page',
      'Filter by role',
      'Filter by status',
      'Sort by',
      'Reverse sort order (currently ascending)',
      'Previous page',
      'Next page',
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it('has no selection column for a viewer who cannot remove members', () => {
    renderRoster({ canRevokeMembers: false });
    expect(screen.queryByTestId('organization-members-select-all')).toBeNull();
    expect(screen.getAllByTestId('roster-row')[0]).toHaveAttribute('data-selectable', 'false');
  });

  it('passes the per-target removal gate to each row', () => {
    renderRoster();
    expect(screen.getByText('Max Manager').closest('[data-testid="roster-row"]')).toHaveAttribute(
      'data-revoke',
      'false'
    );
    expect(screen.getByText('Bob Brown').closest('[data-testid="roster-row"]')).toHaveAttribute('data-revoke', 'true');
  });
});

describe('MemberRoster finding people', () => {
  it('searches by name and by email after the debounce', async () => {
    renderRoster();
    const search = screen.getByTestId('organization-members-search-input');
    fireEvent.change(search, { target: { value: 'bob' } });
    await waitFor(() => expect(shownIds()).toEqual(['bob']));
    fireEvent.change(search, { target: { value: 'MATH.TEST' } });
    await waitFor(() => expect(shownIds()).toEqual(['ada']));
  });

  it('filters by role', async () => {
    renderRoster();
    await choose('organization-members-role-filter', 'Manager');
    expect(shownIds()).toEqual(['mgr', 'me']);
  });

  it('filters by status', async () => {
    renderRoster();
    await choose('organization-members-status-filter', 'Pending');
    expect(shownIds()).toEqual(['pat']);
    await choose('organization-members-status-filter', 'Active');
    expect(shownIds()).not.toContain('pat');
  });

  it('sorts by name, role and usage, and reverses', async () => {
    renderRoster();
    expect(shownIds()).toEqual(['ada', 'bob', 'mgr', 'me', 'owner', 'pat']);
    const reverse = screen.getByTestId('organization-members-sort-btn');
    fireEvent.click(reverse);
    expect(reverse).toHaveAttribute('aria-label', 'Reverse sort order (currently descending)');
    expect(shownIds()).toEqual(['pat', 'owner', 'me', 'mgr', 'bob', 'ada']);
    fireEvent.click(reverse);

    await choose('organization-members-sort-key', 'Sort by role');
    expect(shownIds()).toEqual(['owner', 'mgr', 'me', 'ada', 'bob', 'pat']);

    await choose('organization-members-sort-key', 'Sort by usage');
    expect(shownIds()).toEqual(['me', 'mgr', 'owner', 'bob', 'ada', 'pat']);
  });

  it('offers no usage sort to a viewer who cannot see usage', async () => {
    renderRoster({ canManageCreditBudgets: false });
    await userEvent.click(screen.getByTestId('organization-members-sort-key'));
    expect(screen.queryByRole('option', { name: 'Sort by usage' })).toBeNull();
  });
});

describe('MemberRoster pagination', () => {
  const many = Array.from({ length: 120 }, (_, i) => row({ id: `u${String(i).padStart(3, '0')}` }));

  it('pages through 50 rows at a time', () => {
    renderRoster({ members: many });
    const prev = screen.getByTestId('organization-members-prev-page-btn');
    const next = screen.getByTestId('organization-members-next-page-btn');
    expect(shownIds()).toHaveLength(50);
    expect(screen.getByTestId('organization-members-page-range')).toHaveTextContent('1-50 of 120');
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('organization-members-page-range')).toHaveTextContent('101-120 of 120');
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();
    expect(next).toBeDisabled();
    fireEvent.click(prev);
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
  });

  it('returns to page 1 when a filter changes', async () => {
    renderRoster({ members: many });
    fireEvent.click(screen.getByTestId('organization-members-next-page-btn'));
    await choose('organization-members-status-filter', 'Active');
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('organization-members-next-page-btn'));
    await choose('organization-members-sort-key', 'Sort by role');
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
  });

  it('renders 1,000 members one page at a time', () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => row({ id: `m${i}` }));
    renderRoster({ members: thousand });
    expect(shownIds()).toHaveLength(50);
    expect(screen.getByTestId('organization-members-page-range')).toHaveTextContent('1-50 of 1000');
  });
});

describe('MemberRoster bulk selection', () => {
  const selectAll = () => screen.getByTestId('organization-members-select-all');

  it('offers a checkbox only on rows that can be removed', () => {
    renderRoster();
    for (const name of ['Ada Adams', 'Bob Brown']) expect(screen.getByLabelText(`Select ${name}`)).toBeTruthy();
    // Owner, yourself, a manager you may not remove, and a pending invite.
    for (const name of ['Olive Owner', 'Mia Self', 'Max Manager', 'Pat Pending']) {
      expect(screen.queryByLabelText(`Select ${name}`)).toBeNull();
    }
  });

  it('selects and deselects every removable row on the page', () => {
    renderRoster();
    fireEvent.click(selectAll());
    expect(selectAll()).toBeChecked();
    expect(screen.getByTestId('organization-members-bulk-bar')).toHaveTextContent('2 selected');
    fireEvent.click(selectAll());
    expect(selectAll()).not.toBeChecked();
    expect(screen.queryByTestId('organization-members-bulk-bar')).toBeNull();
  });

  it('shows a partial selection as indeterminate, and select-all completes it', () => {
    renderRoster();
    fireEvent.click(screen.getByLabelText('Select Bob Brown'));
    expect(selectAll()).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(selectAll());
    expect(selectAll()).toBeChecked();
    fireEvent.click(screen.getByLabelText('Select Bob Brown'));
    expect(screen.getByTestId('organization-members-bulk-bar')).toHaveTextContent('1 selected');
  });

  it('clears the selection on demand and when the view changes', async () => {
    renderRoster();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByText('Clear selection'));
    expect(screen.queryByTestId('organization-members-bulk-bar')).toBeNull();
    fireEvent.click(selectAll());
    await choose('organization-members-role-filter', 'Member');
    expect(screen.queryByTestId('organization-members-bulk-bar')).toBeNull();
  });

  it('confirms bulk removal by count and name, then removes each member', async () => {
    mocks.removeMember.mockRejectedValueOnce(new Error('nope'));
    renderRoster();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('organization-members-remove-selected-btn'));
    const args = lastConfirm();
    expect(args.title).toBe('Remove 2 members');
    expect(args.okLabel).toBe('Remove 2 members');
    expect(args.type).toBe('danger');
    render(<>{args.description}</>);
    const description = screen.getByTestId('organization-members-bulk-remove-description');
    expect(description).toHaveTextContent('Remove these 2 members from this team?');
    expect(description).toHaveTextContent('Ada Adams');
    expect(description).toHaveTextContent('Bob Brown');
    expect(description).not.toHaveTextContent('more');

    await args.onOk();
    expect(mocks.removeMember).toHaveBeenNthCalledWith(1, { organizationId: 'org1', userId: 'ada', quiet: true });
    expect(mocks.removeMember).toHaveBeenNthCalledWith(2, { organizationId: 'org1', userId: 'bob', quiet: true });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('removed 1');
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Could not remove Ada Adams (nope)');
    await waitFor(() => expect(screen.queryByTestId('organization-members-bulk-bar')).toBeNull());
  });

  it('uses the singular for one member and reports no failure when all succeed', async () => {
    renderRoster();
    fireEvent.click(screen.getByLabelText('Select Bob Brown'));
    fireEvent.click(screen.getByTestId('organization-members-remove-selected-btn'));
    expect(lastConfirm().title).toBe('Remove 1 member');
    await lastConfirm().onOk();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('removed 1');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('shows no success summary when every removal fails', async () => {
    mocks.removeMember.mockRejectedValue(new Error('nope'));
    renderRoster();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('organization-members-remove-selected-btn'));
    await lastConfirm().onOk();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Could not remove Ada Adams (nope), Bob Brown (nope)');
  });

  it('lists the first ten names and counts the rest', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => row({ id: `x${String(i).padStart(2, '0')}` }));
    renderRoster({ members: twelve });
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('organization-members-remove-selected-btn'));
    render(<>{lastConfirm().description}</>);
    const description = screen.getByTestId('organization-members-bulk-remove-description');
    expect(within(description).getAllByRole('listitem')).toHaveLength(10);
    expect(description).toHaveTextContent('and 2 more');
  });
});
