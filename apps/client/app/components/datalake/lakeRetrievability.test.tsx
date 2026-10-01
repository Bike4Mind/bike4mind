import { describe, it, expect } from 'vitest';
import { isUnsearchable } from './lakeRetrievability';

const lake = { id: 'l1', retrievable: false, status: 'active', canPreauthorize: true } as const;
const ownSession = { userId: 'u1', preauthorizedLakeIds: ['l1'] };

describe('isUnsearchable', () => {
  it('marks only an explicit retrievable === false', () => {
    expect(isUnsearchable({ ...lake, retrievable: true })).toBe(false);
    expect(isUnsearchable({ ...lake, retrievable: undefined })).toBe(false);
    expect(isUnsearchable(lake)).toBe(true);
  });

  it('exempts a lake a session the viewer owns pre-authorizes and the viewer can still pre-authorize', () => {
    expect(isUnsearchable(lake, ownSession, 'u1')).toBe(false);
  });

  // Each mirrors a server-side drop: vetPreauthorizedLakeIds (owner), filterStillManagedLakes
  // (canPreauthorize), and the active-only filter in unionPreauthorizedLakeAccess.
  it.each([
    ['the session belongs to another user', lake, ownSession, 'u2'],
    ['the viewer is unknown', lake, ownSession, undefined],
    ['the viewer can no longer pre-authorize the lake', { ...lake, canPreauthorize: false }, ownSession, 'u1'],
    ['the lake is not active', { ...lake, status: 'draft' }, ownSession, 'u1'],
    ['the session does not name the lake', lake, { userId: 'u1', preauthorizedLakeIds: ['other'] }, 'u1'],
  ] as const)('still marks it when %s', (_label, l, session, viewer) => {
    expect(isUnsearchable(l, session, viewer)).toBe(true);
  });
});
