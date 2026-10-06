import { describe, it, expect } from 'vitest';
import { vetPreauthorizedLakeIds } from './vetPreauthorizedLakeIds';

describe('vetPreauthorizedLakeIds', () => {
  it('passes the ids through when the acting user owns the session', () => {
    const session = { userId: 'owner-1', preauthorizedLakeIds: ['managed'] };

    expect(vetPreauthorizedLakeIds(session, 'owner-1')).toEqual(['managed']);
  });

  // Phase 3, regression case 3: a non-owner posting a turn on a pre-authorized session (a share,
  // a teammate reply, a worker running as the owner with no live requester) gets no widening.
  it('drops the ids when the acting user is not the session owner', () => {
    const session = { userId: 'owner-1', preauthorizedLakeIds: ['managed'] };

    expect(vetPreauthorizedLakeIds(session, 'someone-else')).toBeUndefined();
  });

  it('is a no-op when the session carries no pre-authorization', () => {
    const session = { userId: 'owner-1' };

    expect(vetPreauthorizedLakeIds(session, 'owner-1')).toBeUndefined();
  });
});
