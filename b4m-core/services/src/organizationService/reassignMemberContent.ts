import { IGroupRepository, IOrganizationRepository, IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { isCurrentOrgMember } from './orgAuthority';
import {
  loadOffboardableOrganization,
  orgAgentFilter,
  orgProjectFilter,
  orgSessionFilter,
  orgStampedFilter,
  type OffboardingScope,
} from './offboardingScope';

const parametersSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  reassignTo: z.string().min(1),
});

type Filter = Record<string, unknown>;

interface Reassignable {
  updateMany: (filter: Filter, data: { userId: string }) => Promise<unknown>;
}

export interface ReassignMemberContentAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    fabFiles: Reassignable;
    artifacts: Reassignable;
    projects: Reassignable & {
      find: (filter: Filter, options?: Record<string, unknown>) => Promise<{ id: string; sessionIds?: string[] }[]>;
    };
    sessions: Reassignable;
    agents: Reassignable;
  };
}

export interface ReassignedContentCounts {
  files: number;
  artifacts: number;
  projects: number;
  notebooks: number;
  agents: number;
}

const modifiedCount = (result: unknown): number =>
  typeof result === 'object' && result !== null && 'modifiedCount' in result && typeof result.modifiedCount === 'number'
    ? result.modifiedCount
    : 0;

/**
 * Moves a member's org-context content (the set getMemberOffboardingInventory lists) to another
 * current member or the billing owner. Only `userId` changes: org stamps stay, so org-billed file
 * bytes stay on the org counter and neither member's personal counter (PERSONAL_STORAGE_FILTER)
 * sees them. Call it before revoking the member, inside the caller's transaction.
 */
export async function reassignMemberContent(
  actor: IUserDocument,
  parameters: { id: string; userId: string; reassignTo: string },
  adapters: ReassignMemberContentAdapters
): Promise<ReassignedContentCounts> {
  const { id: organizationId, userId: memberId, reassignTo } = secureParameters(parameters, parametersSchema);
  const { db } = adapters;
  const organization = await loadOffboardableOrganization(actor, organizationId, memberId, db.organizations);
  if (reassignTo === memberId) {
    throw new BadRequestError('Content cannot be transferred to the member being removed.');
  }
  if (!isCurrentOrgMember(organization, reassignTo)) {
    throw new BadRequestError('Content can only be transferred to a current member of the organization.');
  }

  const orgGroupIds = (await db.groups.findByOrganization(organizationId)).map(group => String(group.id));
  const scope: OffboardingScope = { organizationId, memberId, orgGroupIds };

  // Notebook and agent scope hangs off the member's projects, so resolve it before projects move.
  const projectFilter = orgProjectFilter(scope);
  const projects = projectFilter ? await db.projects.find(projectFilter, { sessionIds: 1 }) : [];
  const sessionFilter = orgSessionFilter(
    scope,
    projects.flatMap(project => project.sessionIds ?? [])
  );
  const agentFilter = orgAgentFilter(
    scope,
    projects.map(project => String(project.id))
  );

  const move = async (repo: Reassignable, filter: Filter | null) =>
    filter ? modifiedCount(await repo.updateMany(filter, { userId: reassignTo })) : 0;

  // Sequential so a caller's transaction sees one write at a time.
  const files = await move(db.fabFiles, orgStampedFilter(scope));
  const artifacts = await move(db.artifacts, orgStampedFilter(scope));
  const notebooks = await move(db.sessions, sessionFilter);
  const agents = await move(db.agents, agentFilter);
  const movedProjects = await move(db.projects, projectFilter);

  return { files, artifacts, projects: movedProjects, notebooks, agents };
}
