import { IInviteModelAdapter, IProjectRepository, IUserDocument, InviteType } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export const listProjectInvitesParamsSchema = z.object({
  id: z.string(),
  statuses: z.string().optional().prefault(''),
  limit: z.coerce.number().optional().prefault(10),
  page: z.coerce.number().optional().prefault(1),
});

type ListProjectInvitesParameters = z.infer<typeof listProjectInvitesParamsSchema>;

interface ListProjectInvitesAdapters {
  db: {
    projects: IProjectRepository;
    invites: Pick<IInviteModelAdapter, 'searchInvites'>;
  };
  ability: any; // Replace with proper ability type
}

export const listInvites = async (
  user: IUserDocument,
  params: ListProjectInvitesParameters,
  adapters: ListProjectInvitesAdapters
) => {
  const { id: projectId, statuses, limit, page } = secureParameters(params, listProjectInvitesParamsSchema);

  const project = await adapters.db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }

  // Build filter for recipient status
  const filter: Record<string, any> = {};
  if (statuses) {
    for (const status of statuses.split(',')) {
      if (status === 'pending') {
        filter['recipients.pending'] = { $exists: true, $ne: [] };
      } else if (status === 'accepted') {
        filter['recipients.accepted'] = { $exists: true, $ne: [] };
      } else {
        throw new BadRequestError('Invalid status');
      }
    }
  }

  // Build base query
  const baseQuery = {
    type: InviteType.Project,
    documentId: project.id,
    ...filter,
  };

  const paginatedInvites = await adapters.db.invites.searchInvites(baseQuery, limit, page);

  return paginatedInvites;
};
