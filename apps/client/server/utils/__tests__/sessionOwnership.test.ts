import { describe, it, expect } from 'vitest';
import { isSessionOwnedByUser } from '../sessionOwnership';

describe('isSessionOwnedByUser', () => {
  it('grants the direct owner', () => {
    expect(isSessionOwnedByUser({ userId: 'owner' }, 'owner')).toBe(true);
  });

  it('grants a shared user even when not the owner', () => {
    const session = { userId: 'owner', users: [{ userId: 'shared-viewer' }] };
    expect(isSessionOwnedByUser(session, 'shared-viewer')).toBe(true);
  });

  it('denies a stranger', () => {
    const session = { userId: 'owner', users: [{ userId: 'shared-viewer' }] };
    expect(isSessionOwnedByUser(session, 'stranger')).toBe(false);
  });

  it('denies when the session is missing', () => {
    expect(isSessionOwnedByUser(null, 'owner')).toBe(false);
    expect(isSessionOwnedByUser(undefined, 'owner')).toBe(false);
  });

  it('denies when userId is missing (unauthenticated)', () => {
    expect(isSessionOwnedByUser({ userId: 'owner' }, undefined)).toBe(false);
  });

  it('denies a session with no users array and a non-matching owner', () => {
    expect(isSessionOwnedByUser({ userId: 'owner' }, 'stranger')).toBe(false);
  });
});
