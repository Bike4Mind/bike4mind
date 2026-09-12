import { ExtractSubjectType, MongoAbility } from '@casl/ability';
import { AbilityBuilder, createMongoAbility, MongoQuery } from '@casl/ability';
import {
  Session,
  User,
  FabFile,
  Organization,
  AdminSettings,
  ModalModel,
  CounterLog,
  FeedbackModel,
  Invite,
  Prompt,
  Project,
  UserActivityCounter,
} from '../models';
import { InvitePermission, IUserDocument, Permission, hasDeveloperUserTag } from '@bike4mind/common';

export type Ability = MongoAbility;

/** The `can` of an `AbilityBuilder(createMongoAbility)`, which is what both callers hold. */
type AllowFn = AbilityBuilder<MongoAbility>['can'];

/**
 * The shared user/group share arm, applied to every shareable resource.
 *
 * Called from BOTH ability builders - this one and apps/client/server/auth/ability.ts - so the two
 * cannot drift. They previously kept hand-copied duplicates, which is how a cross-entry over-grant
 * (dotted `users.userId` + `users.permissions` instead of `$elemMatch`) and a missing `Project`
 * resource each survived in one copy while the other was correct.
 *
 * The resource LIST stays with each caller rather than living here, because each builder registers
 * rules against the model objects it imported and CASL matches subjects by constructor - a shared
 * list would close over db-core's models and never match the client's. List drift is what the
 * structural test in ability.test.ts compares; body drift is now impossible.
 */
export function applySharedShareableRules(
  allow: AllowFn,
  user: Pick<IUserDocument, 'id' | 'groups'>,
  resources: readonly Parameters<AllowFn>[1][]
) {
  const ownDocumentPermission: MongoQuery = { userId: user.id };

  resources.forEach(resource => {
    allow(Permission.create, resource);

    // Globals apply to every shareable type.
    allow(Permission.read, resource, { isGlobalRead: true });
    allow(Permission.update, resource, { isGlobalWrite: true });

    [Permission.read, Permission.update, Permission.delete, Permission.share].forEach(permission => {
      allow(permission, resource, ownDocumentPermission);

      // $elemMatch on both arms so the id and the permission must hold on the SAME entry. Dotted
      // `{ 'users.userId': ..., 'users.permissions': ... }` lets the two conditions be satisfied by
      // different array elements: a doc shared with alice (share only) and bob (read) would grant
      // alice read. The group arm has the same shape of cross-entry over-grant. Mirrors the
      // $elemMatch the fabFile search query already uses (fabFileSearchQuery.ts).
      const userWithPermissions: MongoQuery = {
        users: { $elemMatch: { userId: user.id, permissions: permission } },
      };
      const groupWithPermissions: MongoQuery = {
        groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: permission } },
      };
      allow(permission, resource, userWithPermissions);

      if (user.groups?.length) {
        allow(permission, resource, groupWithPermissions);
      }
    });
  });
}

export function defineAbilitiesFor(user: IUserDocument | undefined) {
  const { can: allow, build } = new AbilityBuilder(createMongoAbility);

  if (user) {
    /*
      This causes a 503 error when trying to access the API:
      if (user.isAdmin) {
        allow('manage', 'all'); // Grants all permissions to admin users
      }
      */
    const ownDocumentPermission: MongoQuery = { userId: user.id };

    if (user.isAdmin) {
      allow('read', User);
      allow('update', User);
      allow('delete', User);
      allow('read', CounterLog);
    }

    // Admin Settings permissions
    if (user.isAdmin) {
      allow('create', AdminSettings);
      allow('read', AdminSettings);
      allow('update', AdminSettings);
      allow('delete', AdminSettings);

      allow('create', ModalModel);
      allow('update', ModalModel);
      allow('delete', ModalModel);

      allow('read', Organization);
      allow('update', Organization);
      allow('delete', Organization);

      allow('read', UserActivityCounter);
      allow('update', UserActivityCounter);
    }

    allow('read', UserActivityCounter, ownDocumentPermission);
    allow('update', UserActivityCounter, ownDocumentPermission);

    // Allow all users to read modals
    allow('read', ModalModel);

    // Grant 'readNonAdminSettings' permission for non-admin settings
    if (!user.isAdmin) {
      allow<MongoQuery>('read', AdminSettings, { isAdmin: false });
    }

    applySharedShareableRules(allow, user, [Session, FabFile, Organization, Project]);

    // Additional permissions for specific resources:
    allow('export', Session, ownDocumentPermission);
    allow('clone', Session, ownDocumentPermission);

    // Accept and refuse invites
    allow<MongoQuery>(InvitePermission.acceptOrRefuse, Invite, {
      // Email: absent or matches user email
      $or: [{ 'recipients.pending': { $exists: false } }, { 'recipients.pending': user.email }],
      // Hasn't already accepted:
      'recipients.accepted': { $ne: user.email },
      // Isn't expired:
      expiresAt: { $gt: new Date() },
      // Has remaining uses:
      remaining: { $gt: 0 },
    });
    // Other Invite operations are handled from the `share` permission of the
    // associated shareable (IShareableDocument or Group).

    // Feedback permissions

    // Allow all users to create feedback
    allow(Permission.create, FeedbackModel);

    // Allow users to update their own feedback
    allow(Permission.update, FeedbackModel, {
      userId: user.id,
    });

    // Allow admins to read and delete any feedback
    if (user.isAdmin) {
      allow(Permission.read, FeedbackModel);
      allow(Permission.delete, FeedbackModel);
      allow(Permission.update, FeedbackModel);
    }

    // Allow admins to clone, delete and update sessions
    if (user.isAdmin) {
      allow(Permission.create, Session);
      allow(Permission.delete, Session);
      allow(Permission.update, Session);
      allow('clone', Session);
    }

    // Allow all users to read prompts
    allow(Permission.read, Prompt);

    // Prompt-library management: admin or developer (internal-staff bypass) - the
    // SAME rule as the HTTP ability (apps/client/server/auth/ability.ts). Both
    // definitions previously gated on the literal 'Analyst' tag with no admin
    // fallback; unified 2026-07-08 so the Slack/queue paths that consume this
    // db-core ability match the HTTP path and no longer depend on a retired tag.
    if (user.isAdmin || hasDeveloperUserTag(user.tags)) {
      allow(Permission.create, Prompt);
      allow(Permission.update, Prompt);
      allow(Permission.delete, Prompt);
    }
  }
  return build({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CASL framework requires any for dynamic constructor types
    detectSubjectType: item => item.constructor as ExtractSubjectType<any>,
  });
}
