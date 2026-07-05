import { describe, it, expect } from 'vitest';
import { buildListVisibilityFilter } from './buildListFilter';

describe('buildListVisibilityFilter', () => {
  it('returns null for admins (no restriction)', () => {
    expect(buildListVisibilityFilter({ userId: 'u1', isAdmin: true })).toBeNull();
  });

  it('non-admin sees own + public', () => {
    const f = buildListVisibilityFilter({ userId: 'u1', isAdmin: false });
    expect(f).not.toBeNull();
    expect(f!.$or).toEqual([{ ownerId: 'u1' }, { visibility: 'public' }]);
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
