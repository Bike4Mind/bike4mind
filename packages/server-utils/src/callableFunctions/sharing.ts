import {
  BadRequestError,
  CALLABLE_FUNCTION_GRANT_LIMITS,
  ConflictError,
  NotFoundError,
  effectiveCallableFunctionStatus,
  reviewHash,
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
  callableFunctionReviewRepository,
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

async function isOrganizationMember(userId: string, organizationId: string): Promise<boolean> {
  return (await organizationRepository.findMembershipOrgIds(userId)).includes(organizationId);
}

/**
 * How `caller` reaches `fn`, or null when they do not: the owner; while the function is live, a person named in
 * the grants; a member of the granted project; or a member of the granted organization while that organization has
 * callable functions on. A project or organization grant holds only while the owner is still a member of it.
 */
export async function canCallFunction(
  caller: { id: string },
  fn: Pick<ICallableFunction, 'ownerType' | 'ownerKey' | 'grants' | 'state'>
): Promise<CallableFunctionAccess | null> {
  if (fn.ownerType === 'user' && fn.ownerKey === caller.id) return 'owner';
  const grants = fn.grants;
  // A repin returns the function to draft and keeps its grants; they apply again at the next promotion.
  if (!grants || fn.state !== 'live') return null;
  if (grants.userIds.includes(caller.id)) return 'person';
  if (grants.visibility === 'project' && grants.projectId) {
    const { projectId } = grants;
    const [callerIn, ownerIn] = await Promise.all([
      isProjectMember(caller.id, projectId),
      isProjectMember(fn.ownerKey, projectId),
    ]);
    return callerIn && ownerIn ? 'project' : null;
  }
  if (grants.visibility === 'organization' && grants.organizationId) {
    const { organizationId } = grants;
    const [callerIn, ownerIn] = await Promise.all([
      isOrganizationMember(caller.id, organizationId),
      isOrganizationMember(fn.ownerKey, organizationId),
    ]);
    if (!callerIn || !ownerIn) return null;
    return (await resolveOrganizationCallableFunctionsEnabled(caller, organizationId)) ? 'organization' : null;
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

// Names only: an id in the grants must not turn into an email, and a missing account reads like a nameless one.
export async function displayNamesOf(userIds: string[]): Promise<string[]> {
  const users = userIds.length > 0 ? await userRepository.find({ _id: { $in: userIds } }, { name: 1 }) : [];
  const names = new Map(users.map(user => [String(user._id), (user as { name?: string }).name]));
  return userIds.map(id => names.get(id) || 'Unnamed person');
}

async function peopleOf(userIds: string[]): Promise<CallableFunctionSharePerson[]> {
  const names = await displayNamesOf(userIds);
  return userIds.map((id, index) => ({ id, name: names[index]! }));
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
  // No account read here, so saving answers the same whether or not an id belongs to anyone.
  if (userIds.some(userId => !OBJECT_ID.test(userId))) {
    throw new BadRequestError('One of the people named is not a valid id.', { code: 'invalid_person' });
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

  // A person the edit drops, or everyone outside the new grant when its scope changed, starts at pending if added back.
  const before = current.grants;
  const scopeChanged =
    before?.visibility !== grants.visibility ||
    before?.projectId !== grants.projectId ||
    before?.organizationId !== grants.organizationId;
  if (scopeChanged) {
    await callableFunctionReviewRepository.deleteForFunctionExceptUsers(saved.id, [...userIds, actor.id]);
  } else {
    await callableFunctionReviewRepository.deleteForUsers(
      saved.id,
      (before?.userIds ?? []).filter(userId => !userIds.includes(userId))
    );
  }
  return toCallableFunctionPublic(saved, await readHead(actor, saved.pin.artifactId));
}

/** Removes every grant and review: a former recipient's next call is refused, and a new share starts at pending. */
export async function revokeCallableFunctionShare(
  actor: CallableFunctionActor,
  id: string
): Promise<ICallableFunctionPublic> {
  const saved = await callableFunctionRepository.setGrants(id, userOwner(actor), null);
  if (!saved) throw notFound();
  await callableFunctionReviewRepository.deleteForFunction(saved.id);
  return toCallableFunctionPublic(saved, await readHead(actor, saved.pin.artifactId));
}

/** Functions other people shared with `actor`, each with the actor's review state: no code, artifact, or grants. */
export async function listSharedCallableFunctions(actor: CallableFunctionActor): Promise<ICallableFunctionShared[]> {
  const [projectIds, organizationIds] = await Promise.all([
    projectIdsForMember(actor.id),
    organizationRepository.findMembershipOrgIds(actor.id),
  ]);
  const candidates = await callableFunctionRepository.listSharedWith({ userId: actor.id, projectIds, organizationIds });
  const reachable: { fn: (typeof candidates)[number]; access: Exclude<CallableFunctionAccess, 'owner'> }[] = [];
  for (const fn of candidates) {
    const access = await canCallFunction(actor, fn);
    if (!access || access === 'owner') continue;
    const head = await readHead({ id: fn.userId }, fn.pin.artifactId);
    if (effectiveCallableFunctionStatus(fn, head) !== 'live') continue;
    reachable.push({ fn, access });
  }
  const ownerIds = [...new Set(reachable.map(({ fn }) => fn.userId))];
  const [names, reviews] = await Promise.all([
    displayNamesOf(ownerIds),
    callableFunctionReviewRepository.findForUser(
      actor.id,
      reachable.map(({ fn }) => fn.id)
    ),
  ]);
  const ownerNames = new Map(ownerIds.map((id, index) => [id, names[index]!]));
  const reviewOf = new Map(reviews.map(review => [review.functionId, review]));
  return Promise.all(
    reachable.map(async ({ fn, access }) =>
      toCallableFunctionShared(fn, access, {
        ownerName: ownerNames.get(fn.userId)!,
        reviewHash: await reviewHash(fn.contract),
        review: reviewOf.get(fn.id) ?? null,
      })
    )
  );
}
