import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { IProjectDocument } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  params: undefined as unknown,
  users: [] as Array<Record<string, unknown>>,
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: (params: unknown) => {
    mocks.params = params;
    return { data: { users: mocks.users }, isFetching: false };
  },
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useShareDocument: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? '' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The dialog shell and card are not under test: stand-ins expose the picker contract (row id and
// rendered rows) directly.
vi.mock('./GenericAddItemsModal', () => ({
  default: <T,>(props: {
    items: T[];
    getItemId: (item: T) => string;
    onAdd: (ids: string[]) => void;
    renderItem: (item: T, isSelected: boolean, onSelect: () => void) => ReactNode;
  }) => (
    <div>
      {props.items.map(item => (
        <div key={props.getItemId(item)}>{props.renderItem(item, false, () => {})}</div>
      ))}
      <button data-testid="add-all-btn" onClick={() => props.onAdd(props.items.map(props.getItemId))} />
    </div>
  ),
}));
vi.mock('../common/UserCard', () => ({
  default: ({
    user,
    hideEmail,
    inviteStatus,
    onClick,
  }: {
    user: { name: string };
    hideEmail?: boolean;
    inviteStatus?: string;
    onClick?: () => void;
  }) => (
    <div
      data-testid="user-card"
      data-hide-email={String(!!hideEmail)}
      data-invite-status={inviteStatus ?? ''}
      data-selectable={String(!!onClick)}
    >
      {user.name}
    </div>
  ),
}));

import ProjectAddMembersModal from './AddMembersModal';

const OWNER = 'owner-id';
const project = { id: 'project-id', userId: OWNER, users: [] } as unknown as IProjectDocument;

describe('ProjectAddMembersModal', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    // The non-admin picker returns no email, and an exact-email match outside the caller's
    // workspaces carries no username either.
    mocks.users = [
      { id: 'colleague-id', name: 'Colleague', username: 'colleague' },
      { id: 'exact-match-id', name: 'Exact Match' },
    ];
  });

  it('invites by user id, so a row without a username is still invitable', () => {
    render(<ProjectAddMembersModal project={project} ownerId={OWNER} />);
    fireEvent.click(screen.getByTestId('add-all-btn'));

    const recipients = mocks.mutate.mock.calls.map(([arg]) => arg.recipients);
    expect(recipients).toEqual([['colleague-id'], ['exact-match-id']]);
  });

  it('hides the email line when the row has no email', () => {
    render(<ProjectAddMembersModal project={project} ownerId={OWNER} />);
    const cards = screen.getAllByTestId('user-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.getAttribute('data-hide-email')).toBe('true');
  });

  it('marks a server-flagged pending invitee as pending and not selectable', () => {
    mocks.users = [
      { id: 'invitee-id', name: 'Invitee', username: 'invitee', pendingInvite: true },
      { id: 'colleague-id', name: 'Colleague', username: 'colleague', pendingInvite: false },
    ];
    render(<ProjectAddMembersModal project={project} ownerId={OWNER} />);

    expect(mocks.params).toMatchObject({ pendingInviteProjectId: 'project-id' });
    const [invitee, colleague] = screen.getAllByTestId('user-card');
    expect(invitee.getAttribute('data-invite-status')).toBe('pending');
    expect(invitee.getAttribute('data-selectable')).toBe('false');
    expect(colleague.getAttribute('data-invite-status')).toBe('');
    expect(colleague.getAttribute('data-selectable')).toBe('true');
  });
});
