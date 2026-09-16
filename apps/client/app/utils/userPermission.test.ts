import { describe, it, expect } from 'vitest';
import { Permission } from '@bike4mind/common';
import type { IUserDocument } from '@bike4mind/common';
import {
  canShowConversation,
  userCanDeleteDoc,
  userCanReadDoc,
  userCanShareDoc,
  userCanUpdateDoc,
  type ShareableDocWithUserId,
} from './userPermission';

/**
 * The notebook message list used to be gated solely on `canRead`, which is
 * derived from the session-metadata fetch. On a cold deep-link/refresh that fetch
 * is on the critical path, so messages couldn't paint until it resolved - even
 * when the (server-authorized) `/chat` response had already arrived.
 *
 * `canShowConversation` widens the gate: the `/chat` endpoint enforces read access
 * server-side (getMessagesFromSession -> findAccessibleById), so the presence of
 * authorized conversation content is itself proof the user may read it.
 */
describe('canShowConversation', () => {
  it('shows the conversation when the user can read the session', () => {
    expect(canShowConversation(true, false)).toBe(true);
    expect(canShowConversation(true, true)).toBe(true);
  });

  it('shows the conversation when authorized content is present even before canRead resolves', () => {
    // The cold deep-link case: /chat returned quests (server-authorized) before
    // the metadata fetch that drives canRead has resolved.
    expect(canShowConversation(false, true)).toBe(true);
  });

  it('withholds the conversation only when the user cannot read AND there is no content', () => {
    expect(canShowConversation(false, false)).toBe(false);
  });
});

/**
 * pushShareable keys users[] on (userId, projectId), so one user can legitimately hold several
 * rows on the same document: a direct share plus one per project that materialized access.
 * Reading only the first match would hide a permission the user genuinely holds.
 */
describe('userCan*Doc across multiple share rows', () => {
  const user = { id: 'u1' } as IUserDocument;
  const doc = (users: ShareableDocWithUserId['users']): ShareableDocWithUserId =>
    ({
      id: 'doc-1',
      userId: 'owner',
      users,
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
    }) as ShareableDocWithUserId;

  const multiRow = doc([
    { userId: 'u1', permissions: [Permission.read], projectId: 'project-a' },
    { userId: 'u1', permissions: [Permission.update, Permission.delete, Permission.share], projectId: 'project-b' },
  ]);

  it('unions a permission held only on a later row', () => {
    expect(userCanUpdateDoc(user, multiRow)).toBe(true);
    expect(userCanDeleteDoc(user, multiRow)).toBe(true);
    expect(userCanShareDoc(user, multiRow)).toBe(true);
  });

  it('still honours a permission held only on the first row', () => {
    expect(userCanReadDoc(user, multiRow)).toBe(true);
  });

  it('does not invent a permission no row carries', () => {
    const readOnly = doc([
      { userId: 'u1', permissions: [Permission.read], projectId: 'project-a' },
      { userId: 'u1', permissions: [Permission.read] },
    ]);
    expect(userCanUpdateDoc(user, readOnly)).toBe(false);
    expect(userCanDeleteDoc(user, readOnly)).toBe(false);
    expect(userCanShareDoc(user, readOnly)).toBe(false);
  });

  it('does not read another user rows', () => {
    const someoneElse = doc([{ userId: 'u2', permissions: [Permission.read, Permission.update] }]);
    expect(userCanReadDoc(user, someoneElse)).toBe(false);
    expect(userCanUpdateDoc(user, someoneElse)).toBe(false);
  });
});
