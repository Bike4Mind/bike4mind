import { describe, it, expect, vi } from 'vitest';

const getDynamicDataLakeAccessMock = vi.fn();
vi.mock('../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

import { resolveSessionLakeAccess } from './resolveSessionLakeAccess';
import type { ToolContext } from './types';
import type { ResolvedLakeAccessSet } from '../../../dataLakeService/narrowLakeAccessToSession';

const RESOLVED: ResolvedLakeAccessSet = {
  dataLakeTags: ['datalake:alpha'],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: ['alpha:'],
  lakes: [
    {
      id: 'alpha',
      name: 'alpha',
      slug: 'alpha',
      datalakeTag: 'datalake:alpha',
      fileTagPrefix: 'alpha:',
      membership: { kind: 'owned', datalakeTag: 'datalake:alpha', fileTagPrefix: 'alpha:', creatorUserId: 'owner-1' },
      source: 'dynamic',
    },
  ] as ResolvedLakeAccessSet['lakes'],
};

const MANAGED_LAKE = {
  id: 'managed',
  name: 'Managed Lake',
  slug: 'managed-lake',
  datalakeTag: 'datalake:managed',
  fileTagPrefix: 'managed:',
  status: 'active',
  createdByUserId: 'other-user',
};

/**
 * A db that resolves the managed lake and holds a curator grant for `grantee`. Defaults to the
 * context's own `userId`, so a test that wants the admission gets it and a test that wants it
 * revoked names someone else - which is also what pins that this function passes `context.userId`
 * as the re-check actor rather than some other id.
 */
const preauthDb = (grantee: string = 'u1') =>
  ({
    dataLakes: { findById: vi.fn().mockResolvedValue(MANAGED_LAKE) },
    dataLakeAccessGrants: {
      listActiveByLakes: vi
        .fn()
        .mockResolvedValue([{ dataLakeId: 'managed', principalType: 'user', principalId: grantee, role: 'curator' }]),
    },
    organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
  }) as never;

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    userId: 'u1',
    user: { id: 'u1' } as never,
    db: {} as never,
    ...overrides,
  }) as ToolContext;

describe('resolveSessionLakeAccess', () => {
  it('short-circuits to no lakes when the context suppresses lake arms, without calling the resolver', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);
    const out = await resolveSessionLakeAccess(makeContext({ suppressLakeArms: true }));

    expect(out.lakes).toEqual([]);
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('unions a pre-authorized lake in before narrowing to the session tags', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);

    const out = await resolveSessionLakeAccess(
      makeContext({
        sessionPreauthorizedLakeIds: ['managed'],
        sessionRetrievalTags: ['datalake:managed'],
        db: preauthDb(),
      })
    );

    // Pins that the union ran AT ALL: without it the narrow to ['datalake:managed'] would drop
    // 'alpha' and return []. It does NOT pin the ordering - both orders yield ['managed'] here
    // (narrow-first gives [], then the union adds 'managed'). The next test covers the ordering.
    expect(out.lakes.map(l => l.id)).toEqual(['managed']);
  });

  // The discriminating fixture for composition ORDER, and the reason it has to be separate from the
  // case above: scoping the session to a lake the grant does NOT name is the only shape where the two
  // orders disagree. Union-then-narrow (shipped) lets the narrow drop the pre-authorized lake the
  // session was never scoped to -> ['alpha']. Narrow-then-union would re-add it after the narrow had
  // already run -> ['alpha', 'managed'], putting 'datalake:managed' into the tag set the search query
  // is built from, so the grant would escape the session's own scoping.
  it('narrows a pre-authorized lake back out when the session is scoped to a different lake', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);

    // The grant is held ON PURPOSE: with the admission revoked this would return ['alpha'] too,
    // and the test would pass without ever exercising the narrow it exists to pin.
    const out = await resolveSessionLakeAccess(
      makeContext({
        sessionPreauthorizedLakeIds: ['managed'],
        sessionRetrievalTags: ['datalake:alpha'],
        db: preauthDb(),
      })
    );

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
    expect(out.dataLakeTags).not.toContain('datalake:managed');
  });

  // Pins the actor the manage re-check runs as. The session document is identical to the admitting
  // case above - only the grant's principal differs - so a re-check wired to the wrong id (or to
  // no id) would admit here and hand a revoked maintainer the lake's files for the whole session.
  it('drops a pre-authorized lake whose manage grant names a different principal', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);

    const out = await resolveSessionLakeAccess(
      makeContext({
        sessionPreauthorizedLakeIds: ['managed'],
        sessionRetrievalTags: ['datalake:managed'],
        db: preauthDb('someone-else'),
      })
    );

    expect(out.lakes).toEqual([]);
  });

  it('leaves the resolved access unchanged when the session names no lake opinion', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);
    const out = await resolveSessionLakeAccess(makeContext({ sessionRetrievalTags: undefined }));

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });
});
