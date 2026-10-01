import { describe, it, expect, vi } from 'vitest';
import { NO_SESSION_LAKES, resolveSessionLakeAdmission } from './sessionLakeAdmission';
import { sessionGroundsOnNoLake, type ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

const ACTOR = 'maintainer-1';

const lakeEntry = (name: string) => ({
  id: name,
  name,
  slug: name,
  datalakeTag: `datalake:${name}`,
  fileTagPrefix: `${name}:`,
  membership: { kind: 'owned', datalakeTag: `datalake:${name}`, fileTagPrefix: `${name}:`, creatorUserId: ACTOR },
  source: 'dynamic',
});

const access = (): ResolvedLakeAccessSet => ({
  dataLakeTags: ['datalake:alpha', 'datalake:beta'],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: ['alpha:', 'beta:'],
  lakes: [lakeEntry('alpha'), lakeEntry('beta')] as ResolvedLakeAccessSet['lakes'],
  excludedByAccessCount: 0,
});

// Someone else's lake, admitted only through the actor's curator grant.
const managedLake = {
  id: 'managed',
  name: 'Managed Lake',
  slug: 'managed-lake',
  datalakeTag: 'datalake:managed',
  fileTagPrefix: 'managed:',
  status: 'active',
  createdByUserId: 'other-user',
};

const db = () => ({
  dataLakes: { findById: vi.fn().mockResolvedValue(managedLake) } as never,
  dataLakeAccessGrants: {
    listActiveByLakes: vi
      .fn()
      .mockResolvedValue([{ dataLakeId: 'managed', principalType: 'user', principalId: ACTOR, role: 'curator' }]),
  } as never,
  organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) } as never,
});

const tagsOf = (set: ResolvedLakeAccessSet) => set.lakes.map(l => l.datalakeTag).sort();

describe('resolveSessionLakeAdmission', () => {
  it('admits and searches the full access when the session names no lake and is not explicit', async () => {
    const { admitted, searched } = await resolveSessionLakeAdmission(access(), {}, ACTOR, db());
    expect(tagsOf(admitted)).toEqual(['datalake:alpha', 'datalake:beta']);
    expect(tagsOf(searched)).toEqual(['datalake:alpha', 'datalake:beta']);
  });

  it('keeps every lake admitted but searches only the session-named one', async () => {
    const { admitted, searched } = await resolveSessionLakeAdmission(
      access(),
      { retrievalTags: ['datalake:alpha'] },
      ACTOR,
      db()
    );
    expect(tagsOf(admitted)).toEqual(['datalake:alpha', 'datalake:beta']);
    expect(tagsOf(searched)).toEqual(['datalake:alpha']);
  });

  it('admits the still-managed pre-authorized lake into both sets when the session names it', async () => {
    const { admitted, searched } = await resolveSessionLakeAdmission(
      access(),
      { retrievalTags: ['datalake:managed'], preauthorizedLakeIds: ['managed'] },
      ACTOR,
      db()
    );
    expect(tagsOf(admitted)).toEqual(['datalake:alpha', 'datalake:beta', 'datalake:managed']);
    expect(tagsOf(searched)).toEqual(['datalake:managed']);
  });

  it('searches nothing for an explicit empty scope while still admitting the caller access', async () => {
    const session = { retrievalTags: [], lakeScopeExplicit: true, preauthorizedLakeIds: ['managed'] };
    expect(sessionGroundsOnNoLake(session.retrievalTags, session.lakeScopeExplicit)).toBe(true);

    const { admitted, searched } = await resolveSessionLakeAdmission(access(), session, ACTOR, db());
    expect(tagsOf(admitted)).toEqual(['datalake:alpha', 'datalake:beta', 'datalake:managed']);
    expect(searched).toEqual(NO_SESSION_LAKES);
  });

  it('treats an empty scope that is NOT explicit as unscoped', async () => {
    expect(sessionGroundsOnNoLake([], false)).toBe(false);
    const { searched } = await resolveSessionLakeAdmission(
      access(),
      { retrievalTags: [], lakeScopeExplicit: false },
      ACTOR,
      db()
    );
    expect(tagsOf(searched)).toEqual(['datalake:alpha', 'datalake:beta']);
  });
});
