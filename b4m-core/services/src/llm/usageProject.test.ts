import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IProjectDocument, type IUserDocument } from '@bike4mind/common';
import { resolveUsageProject } from './usageProject';

const projectId = '665000000000000000000001';
const user = { id: 'user-1' } as IUserDocument;

describe('resolveUsageProject', () => {
  const arrange = (project: (Partial<IProjectDocument> & { organizationId?: string }) | null) => {
    const findAccessibleById = vi.fn().mockResolvedValue(project);
    const projects = { shareable: { findAccessibleById } } as unknown as Parameters<
      typeof resolveUsageProject
    >[0]['projects'];
    return { projects, findAccessibleById };
  };

  it('validates the explicit project against caller access and persisted org binding', async () => {
    const { projects, findAccessibleById } = arrange({ id: projectId, organizationId: 'org-1' });
    expect(
      await resolveUsageProject({
        projectId,
        user,
        projects,
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
      })
    ).toBe(projectId);
    expect(findAccessibleById).toHaveBeenCalledWith(user, projectId);
  });

  it.each([
    null,
    { id: projectId },
    { id: projectId, organizationId: 'other-org' },
    { id: projectId, organizationId: 'org-1', deletedAt: new Date() },
  ])('leaves inaccessible, historical, cross-org or deleted project context Unassigned: %j', async project => {
    const { projects } = arrange(project);
    expect(
      await resolveUsageProject({
        projectId,
        user,
        projects,
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
      })
    ).toBeUndefined();
  });

  it.each([undefined, '', 'invalid'])('does not infer a project when explicit context is %s', async explicit => {
    const { projects, findAccessibleById } = arrange({ id: projectId, organizationId: 'org-1' });
    expect(
      await resolveUsageProject({
        projectId: explicit,
        user,
        projects,
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
      })
    ).toBeUndefined();
    expect(findAccessibleById).not.toHaveBeenCalled();
  });

  it('keeps personally billed usage out of org-bound projects', async () => {
    const { projects } = arrange({ id: projectId, userId: user.id, organizationId: 'org-1' });
    expect(
      await resolveUsageProject({ projectId, user, projects, ownerId: user.id, ownerType: CreditHolderType.User })
    ).toBeUndefined();
  });
});
