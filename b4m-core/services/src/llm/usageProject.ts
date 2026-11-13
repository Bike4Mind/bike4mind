import { CreditHolderType, type IProjectRepository, type IUserDocument } from '@bike4mind/common';

export async function resolveUsageProject({
  projectId,
  user,
  ownerId,
  ownerType,
  projects,
}: {
  projectId?: string;
  user: IUserDocument;
  ownerId: string;
  ownerType: CreditHolderType;
  projects: Pick<IProjectRepository, 'shareable'>;
}): Promise<string | undefined> {
  if (!projectId || !/^[a-f\d]{24}$/i.test(projectId)) return undefined;
  const project = await projects.shareable.findAccessibleById(user, projectId);
  if (!project || project.deletedAt) return undefined;
  const binding = project.organizationId;
  if (ownerType === CreditHolderType.Organization) {
    return binding === ownerId ? project.id : undefined;
  }
  return ownerType === CreditHolderType.User && !binding && project.userId === ownerId ? project.id : undefined;
}
