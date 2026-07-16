import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression guard for issue #610: the project-scope publish check must query the
 * stored membership path `users.userId` (rows are { userId, permissions, projectId }
 * - see sharingService pushShareable), NOT the nonexistent `users.id`, which matched
 * no documents and denied publish access to non-owner project members.
 */

const { projectFindOne } = vi.hoisted(() => ({ projectFindOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  Project: { findOne: (...a: unknown[]) => projectFindOne(...a) },
}));

import { checkScopePermission, type PublishUser } from './checkScopePermission';

const user = (over: Partial<PublishUser> = {}): PublishUser => ({
  id: 'user_1',
  isAdmin: false,
  organizationId: null,
  ...over,
});

// Project.findOne(...).select('_id').lean()
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

describe('checkScopePermission - project scope membership path (#610)', () => {
  beforeEach(() => {
    projectFindOne.mockReset();
  });

  it('queries the stored users.userId membership path, never users.id', async () => {
    projectFindOne.mockReturnValue(lean(null));
    await checkScopePermission({ user: user(), tier: 'project', scopeId: 'p1' });

    const [query] = projectFindOne.mock.calls[0] as [{ $or: Array<Record<string, unknown>> }];
    expect(query.$or).toEqual(expect.arrayContaining([{ userId: 'user_1' }, { 'users.userId': 'user_1' }]));
    expect(query.$or.flatMap(clause => Object.keys(clause))).not.toContain('users.id');
  });

  it('allows a project member (row matched by users.userId)', async () => {
    projectFindOne.mockReturnValue(lean({ _id: 'p1' }));
    expect(await checkScopePermission({ user: user(), tier: 'project', scopeId: 'p1' })).toEqual({ ok: true });
  });

  it('403s a non-member', async () => {
    projectFindOne.mockReturnValue(lean(null));
    expect(await checkScopePermission({ user: user(), tier: 'project', scopeId: 'p1' })).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});
