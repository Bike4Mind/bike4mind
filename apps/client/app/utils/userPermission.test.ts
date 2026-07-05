import { describe, it, expect } from 'vitest';
import { canShowConversation } from './userPermission';

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
