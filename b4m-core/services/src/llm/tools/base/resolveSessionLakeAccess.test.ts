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
    const findById = vi.fn().mockResolvedValue({
      id: 'managed',
      name: 'Managed Lake',
      slug: 'managed-lake',
      datalakeTag: 'datalake:managed',
      fileTagPrefix: 'managed:',
      status: 'active',
      createdByUserId: 'other-user',
    });

    const out = await resolveSessionLakeAccess(
      makeContext({
        sessionPreauthorizedLakeIds: ['managed'],
        sessionRetrievalTags: ['datalake:managed'],
        db: { dataLakes: { findById } } as never,
      })
    );

    // The narrow (session tags = ['datalake:managed']) keeps ONLY the unioned lake - proving
    // union really ran before narrow, not after (a post-narrow union would leak 'alpha' back in
    // via a raw union, or the narrow would drop 'managed' if union never ran at all).
    expect(out.lakes.map(l => l.id)).toEqual(['managed']);
  });

  it('leaves the resolved access unchanged when the session names no lake opinion', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue(RESOLVED);
    const out = await resolveSessionLakeAccess(makeContext({ sessionRetrievalTags: undefined }));

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });
});
