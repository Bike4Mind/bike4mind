import { IGroupRepository, IOrganizationRepository, isOrgMember, IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
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
  updateMany: (filter: Filter, data: { userId: string; name?: string }) => Promise<unknown>;
}

export interface ReassignMemberContentAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    fabFiles: Reassignable;
    artifacts: Reassignable;
    projects: Reassignable & {
      find: (filter: Filter, options?: Record<string, unknown>) => Promise<{ id: string; name: string }[]>;
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
  // isOrgMember, not isCurrentOrgMember: a roster row that confers no membership permission must not
  // receive content.
  if (!isOrgMember({ id: reassignTo }, organization)) {
    throw new BadRequestError('Content can only be transferred to a current member of the organization.');
  }

  const orgGroupIds = (await db.groups.findByOrganization(organizationId)).map(group => String(group.id));
  const scope: OffboardingScope = { organizationId, memberId, orgGroupIds };

  const move = async (repo: Reassignable, filter: Filter | null) =>
    filter ? modifiedCount(await repo.updateMany(filter, { userId: reassignTo })) : 0;

  // Sequential so a caller's transaction sees one write at a time.
  const files = await move(db.fabFiles, orgStampedFilter(scope));
  const artifacts = await move(db.artifacts, orgStampedFilter(scope));
  const notebooks = await move(db.sessions, orgSessionFilter(scope));
  const agents = await move(db.agents, orgAgentFilter(scope));
  const movedProjects = await moveProjects(db.projects, orgProjectFilter(scope), reassignTo);

  return { files, artifacts, projects: movedProjects, notebooks, agents };
}

/**
 * Project names are unique per owner among live projects (ProjectModel's partial unique index), so
 * a project whose name the recipient already uses moves under a suffixed name instead of failing
 * the whole transfer.
 */
async function moveProjects(
  projects: ReassignMemberContentAdapters['db']['projects'],
  filter: Filter | null,
  reassignTo: string
): Promise<number> {
  if (!filter) return 0;
  const moving = await projects.find(filter, { name: 1 });
  if (moving.length === 0) return 0;
  const taken = new Set((await projects.find({ userId: reassignTo, deletedAt: null }, { name: 1 })).map(p => p.name));
  let moved = 0;
  for (const project of moving) {
    let name = project.name;
    for (let n = 1; taken.has(name); n++) {
      name = n === 1 ? `${project.name} (transferred)` : `${project.name} (transferred ${n})`;
    }
    taken.add(name);
    const data = name === project.name ? { userId: reassignTo } : { userId: reassignTo, name };
    moved += modifiedCount(await projects.updateMany({ ...filter, _id: project.id }, data));
  }
  return moved;
}
