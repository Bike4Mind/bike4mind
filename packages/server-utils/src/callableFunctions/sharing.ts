import {
  BadRequestError,
  CALLABLE_FUNCTION_GRANT_LIMITS,
  ConflictError,
  NotFoundError,
  toCallableFunctionPublic,
  toCallableFunctionShared,
  type CallableFunctionAccess,
  type CallableFunctionGrantVisibility,
  type ICallableFunction,
  type ICallableFunctionGrants,
  type ICallableFunctionPublic,
  type ICallableFunctionShared,
} from '@bike4mind/common';
import {
  artifactRepository,
  callableFunctionRepository,
  organizationRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { resolveOrganizationCallableFunctionsEnabled } from './access';
import type { CallableFunctionActor } from './registry';

/**
 * Sharing a live function with named people, a project, or an organization. Membership is read again on every
 * check, so a person who leaves a project or organization is refused at their next call.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const userOwner = (actor: CallableFunctionActor) => ({ ownerType: 'user' as const, ownerKey: actor.id });

const notFound = () => new NotFoundError('Tool not found');

/** The owner and the people named on the project with read or write: the named arms of `readAccessArms`. */
const projectMemberFilter = (userId: string) => ({
  deletedAt: null,
  $or: [{ userId }, { users: { $elemMatch: { userId, permissions: { $in: ['read', 'write'] } } } }],
});

async function isProjectMember(userId: string, projectId: string): Promise<boolean> {
  if (!OBJECT_ID.test(projectId)) return false;
  return (await projectRepository.findOne({ _id: projectId, ...projectMemberFilter(userId) })) !== null;
}

async function projectIdsForMember(userId: string): Promise<string[]> {
  const projects = await projectRepository.find(projectMemberFilter(userId), { _id: 1 });
  return projects.map(project => String(project._id));
}

/**
 * How `caller` reaches `fn`, or null when they do not: the owner; a person named in the grants; a member of the
 * granted project; or a member of the granted organization while that organization has callable functions on.
 */
export async function canCallFunction(
  caller: { id: string },
  fn: Pick<ICallableFunction, 'ownerType' | 'ownerKey' | 'grants'>
): Promise<CallableFunctionAccess | null> {
  if (fn.ownerType === 'user' && fn.ownerKey === caller.id) return 'owner';
  const grants = fn.grants;
  if (!grants) return null;
  if (grants.userIds.includes(caller.id)) return 'person';
  if (grants.visibility === 'project' && grants.projectId) {
    return (await isProjectMember(caller.id, grants.projectId)) ? 'project' : null;
  }
  if (grants.visibility === 'organization' && grants.organizationId) {
    const orgIds = await organizationRepository.findMembershipOrgIds(caller.id);
    if (!orgIds.includes(grants.organizationId)) return null;
    return (await resolveOrganizationCallableFunctionsEnabled(caller, grants.organizationId)) ? 'organization' : null;
  }
  return null;
}

export interface CallableFunctionShareInput {
  visibility: CallableFunctionGrantVisibility;
  projectId?: string;
  organizationId?: string;
  userIds: string[];
}

export interface CallableFunctionSharePerson {
  id: string;
  name: string;
}

/** The owner's view of a function's share: the grants and the named people's display names. */
export interface CallableFunctionShareView {
  grants: ICallableFunctionGrants | null;
  people: CallableFunctionSharePerson[];
}

async function namesOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await userRepository.find({ _id: { $in: userIds } }, { name: 1, email: 1 });
  return new Map(
    users.map(user => {
      const { name, email } = user as { name?: string; email?: string };
      return [String(user._id), name || email || ''];
    })
  );
}

async function peopleOf(userIds: string[]): Promise<CallableFunctionSharePerson[]> {
  const names = await namesOf(userIds);
  return userIds.map(id => ({ id, name: names.get(id) || 'Unknown person' }));
}

export async function getCallableFunctionShare(
  actor: CallableFunctionActor,
  id: string
): Promise<CallableFunctionShareView> {
  const fn = await callableFunctionRepository.findByIdForOwner(id, userOwner(actor));
  if (!fn) throw notFound();
  return { grants: fn.grants ?? null, people: await peopleOf(fn.grants?.userIds ?? []) };
}

async function readHead(actor: CallableFunctionActor, artifactId: string) {
  const artifact = await artifactRepository.findOne({ id: artifactId, userId: actor.id });
  return artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
}

/** Replaces the grants of the owner's live function. The owner must belong to the project or organization named. */
export async function shareCallableFunction(
  actor: CallableFunctionActor,
  id: string,
  input: CallableFunctionShareInput
): Promise<ICallableFunctionPublic> {
  const owner = userOwner(actor);
  const current = await callableFunctionRepository.findByIdForOwner(id, owner);
  if (!current) throw notFound();
  if (current.state !== 'live') {
    throw new ConflictError('Promote the tool before sharing it: a share covers the live version.', {
      code: 'not_live',
    });
  }

  const userIds = [...new Set(input.userIds)].filter(userId => userId !== actor.id);
  const { maxUserIds } = CALLABLE_FUNCTION_GRANT_LIMITS;
  if (userIds.length > maxUserIds) {
    throw new BadRequestError(`A tool can be shared with at most ${maxUserIds} people.`, { code: 'too_many_people' });
  }
  if (userIds.some(userId => !OBJECT_ID.test(userId)) || (await namesOf(userIds)).size !== userIds.length) {
    throw new BadRequestError('One of the people named was not found.', { code: 'unknown_person' });
  }

  const grants: ICallableFunctionGrants = { visibility: input.visibility, userIds };
  if (input.visibility === 'project') {
    if (!input.projectId || !(await isProjectMember(actor.id, input.projectId))) {
      throw new NotFoundError('Project not found');
    }
    grants.projectId = input.projectId;
  } else if (input.visibility === 'organization') {
    const orgIds = await organizationRepository.findMembershipOrgIds(actor.id);
    if (!input.organizationId || !orgIds.includes(input.organizationId)) {
      throw new NotFoundError('Organization not found');
    }
    grants.organizationId = input.organizationId;
  } else if (userIds.length === 0) {
    throw new BadRequestError('Name at least one person, a project, or an organization.', { code: 'no_recipients' });
  }

  const saved = await callableFunctionRepository.setGrants(id, owner, grants);
  // The function returned to draft between the read and this write.
  if (!saved) {
    throw new ConflictError('Promote the tool before sharing it: a share covers the live version.', {
      code: 'not_live',
    });
  }
  return toCallableFunctionPublic(saved, await readHead(actor, saved.pin.artifactId));
}

/** Removes every grant; the next call by a former recipient is refused. */
export async function revokeCallableFunctionShare(
  actor: CallableFunctionActor,
  id: string
): Promise<ICallableFunctionPublic> {
  const saved = await callableFunctionRepository.setGrants(id, userOwner(actor), null);
  if (!saved) throw notFound();
  return toCallableFunctionPublic(saved, await readHead(actor, saved.pin.artifactId));
}

/** Functions other people shared with `actor`, each as pending review: no code, no artifact, no grants. */
export async function listSharedCallableFunctions(actor: CallableFunctionActor): Promise<ICallableFunctionShared[]> {
  const [projectIds, organizationIds] = await Promise.all([
    projectIdsForMember(actor.id),
    organizationRepository.findMembershipOrgIds(actor.id),
  ]);
  const candidates = await callableFunctionRepository.listSharedWith({ userId: actor.id, projectIds, organizationIds });
  const shared: ICallableFunctionShared[] = [];
  for (const fn of candidates) {
    const access = await canCallFunction(actor, fn);
    if (access && access !== 'owner') shared.push(toCallableFunctionShared(fn, access));
  }
  return shared;
}
