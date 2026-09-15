import { describe, it, expect } from 'vitest';
import { buildListVisibilityFilter } from './buildListFilter';

describe('buildListVisibilityFilter', () => {
  it('returns null for admins (no restriction)', () => {
    expect(buildListVisibilityFilter({ userId: 'u1', isAdmin: true })).toBeNull();
  });

  it('non-admin sees own + ungated public', () => {
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false });
    expect(f).not.toBeNull();
    expect(f!.$or).toEqual([{ ownerId: 'u1' }, { visibility: 'public', accessGate: null }]);
  });

  it('excludes gated public artifacts from the non-owner clause', () => {
    // A passphrase/domain-gated public artifact must not list to a stranger: the gate holds
    // on the serve path, but the row itself disclosed the title, tags and URL parts. Matches
    // the 404 that GET /api/publish/artifacts/[id] already returns for the same case.
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false });
    const publicClause = f!.$or.find(c => (c as { visibility?: string }).visibility === 'public');
    expect(publicClause).toEqual({ visibility: 'public', accessGate: null });
  });

  it('still lists the owner own gated artifacts', () => {
    // The ownerId clause carries no gate condition, so a gate never hides your own row.
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false });
    expect(f!.$or).toContainEqual({ ownerId: 'u1' });
  });

  it('includes an org clause when the user has an organizationId', () => {
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false, userOrganizationId: 'org9' });
    expect(f!.$or).toContainEqual({ visibility: 'organization', tier: 'organization', scopeId: 'org9' });
  });

  it('includes a project clause for the user accessible projects', () => {
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false, userProjectIds: ['p1', 'p2'] });
    expect(f!.$or).toContainEqual({ visibility: 'project', tier: 'project', scopeId: { $in: ['p1', 'p2'] } });
  });

  it('omits the project clause when there are no accessible projects', () => {
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false, userProjectIds: [] });
    expect(f!.$or.some(c => 'tier' in c && (c as { tier?: string }).tier === 'project')).toBe(false);
  });
});
