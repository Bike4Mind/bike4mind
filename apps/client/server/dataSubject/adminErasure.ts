import {
  NotFoundError,
  assertCanActOnAdminTarget,
  type AdminErasurePreview,
  type AdminErasureState,
  type IUserDeletion,
} from '@bike4mind/common';
import { User, userRepository } from '@bike4mind/database';
import { SubjectErasurePlan } from './subjectErasurePlan';

type AdminActor = Parameters<typeof assertCanActOnAdminTarget>[0];

/** The user named by the route, whose data this admin may erase: only full admins erase an admin's. */
export async function findErasureTarget(actor: AdminActor, userId: unknown) {
  const user = typeof userId === 'string' && userId ? await userRepository.findById(userId) : null;
  if (!user) throw new NotFoundError('User not found');
  assertCanActOnAdminTarget(actor, user, 'erase the data of');
  return {
    user,
    auditTarget: { kind: 'user' as const, id: user.id, displayName: user.email ?? user.username ?? user.id },
  };
}

export async function readAdminErasureState(userId: string): Promise<AdminErasureState> {
  const found = await User.findById(userId, { deletion: 1 }).lean<{ deletion?: IUserDeletion | null }>();
  const deletion = found?.deletion;
  if (!deletion) return { state: 'none' };
  if (deletion.source !== 'admin')
    return { state: 'selfDeletionPending', scheduledFor: deletion.scheduledFor.toISOString() };
  return {
    state: 'requested',
    requestedAt: deletion.requestedAt.toISOString(),
    requestedBy: deletion.requestedBy ?? null,
    purgeStartedAt: deletion.purgeStartedAt?.toISOString() ?? null,
  };
}

/** The dry run: what an erasure would do to each collection naming the user, per the data holder registry. */
export async function previewAdminErasure(user: { id: string; email?: string | null }): Promise<AdminErasurePreview> {
  const collections = await new SubjectErasurePlan({ userId: user.id, email: user.email ?? null }).collections();
  return { generatedAt: new Date().toISOString(), collections };
}
