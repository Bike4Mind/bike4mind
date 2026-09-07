import { describe, it, expect, vi } from 'vitest';
import { unionPreauthorizedLakeAccess } from './unionPreauthorizedLakeAccess';
import type { ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

const access = (): ResolvedLakeAccessSet => ({
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
});

const managedLake = (overrides: Partial<{ id: string; status: string }> = {}) => ({
  id: overrides.id ?? 'managed',
  name: 'Managed Lake',
  slug: 'managed-lake',
  datalakeTag: 'datalake:managed',
  fileTagPrefix: 'managed:',
  status: overrides.status ?? 'active',
  createdByUserId: 'other-user',
  organizationId: undefined,
});

describe('unionPreauthorizedLakeAccess', () => {
  it('adds a pre-authorized lake the caller could not otherwise reach', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake());
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], { dataLakes: { findById } as never });

    expect(out.lakes.map(l => l.id)).toEqual(['alpha', 'managed']);
    expect(out.dataLakeTags).toEqual(['datalake:alpha', 'datalake:managed']);
    expect(out.scopedTagPrefixes).toEqual(['alpha:', 'managed:']);
  });

  it('is a no-op when no ids are pre-authorized', async () => {
    const findById = vi.fn();
    const out = await unionPreauthorizedLakeAccess(access(), undefined, { dataLakes: { findById } as never });

    expect(out).toEqual(access());
    expect(findById).not.toHaveBeenCalled();
  });

  it('does not re-fetch a lake already present in the resolved set', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake());
    const out = await unionPreauthorizedLakeAccess(access(), ['alpha'], { dataLakes: { findById } as never });

    expect(findById).not.toHaveBeenCalled();
    expect(out).toEqual(access());
  });

  it('drops a pre-authorized id that no longer resolves to an active lake', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake({ status: 'archived' }));
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], { dataLakes: { findById } as never });

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });

  it('drops a pre-authorized id that no longer exists', async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const out = await unionPreauthorizedLakeAccess(access(), ['gone'], { dataLakes: { findById } as never });

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });

  it('is a no-op when the context carries no dataLakes repository (e.g. a suppressed arm)', async () => {
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], {});

    expect(out).toEqual(access());
  });

  // #2243: retrieval derives its membership arms from `lakes`, so a unioned entry must carry a
  // real membership scope, not a stand-in - lakeMembershipScope resolves it from the lake's own
  // ownership/organization fields, the same derivation the rest of this file's entries use.
  it('gives the unioned entry a real membership scope, not a placeholder', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake());
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], { dataLakes: { findById } as never });

    const entry = out.lakes.find(l => l.id === 'managed');
    expect(entry?.membership).toMatchObject({ creatorUserId: 'other-user' });
  });
});
