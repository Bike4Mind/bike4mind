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
  UserActivityCounter,
} from '../models';
import { InvitePermission, IUserDocument, Permission, hasDeveloperUserTag } from '@bike4mind/common';

export type Ability = MongoAbility;
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

    // Do some loops to handle common patterns:
    //  -- Users can manage their own stuff (ownDocumentPermission)
    //  -- Users can do anything shared with their userId
    //  -- If user is in groups, we check group permissions as well
    [Session, FabFile, Organization].forEach(resource => {
      allow(Permission.create, resource);

      // Support globals for all document types:
      allow(Permission.read, resource, { isGlobalRead: true });
      allow(Permission.update, resource, { isGlobalWrite: true });

      // Support user/group permissions for all document types:
      [Permission.read, Permission.update, Permission.delete, Permission.share].forEach(permission => {
        // Add permission for user to manage their own documents:
        allow(permission, resource, ownDocumentPermission);

        const userWithPermissions: MongoQuery = {
          'users.userId': user.id,
          'users.permissions': permission,
        };
        const groupWithPermissions: MongoQuery = {
          'groups.groupId': { $in: user.groups },
          'groups.permissions': permission,
        };
        // Support sharing with specific user IDs:
        allow(permission, resource, userWithPermissions);

        // If user has any groups, add group permissions:
        if (user.groups?.length) {
          // Allow <permission> if any of the user's groups allows <permission>:
          allow(permission, resource, groupWithPermissions);
        }
      });
    });
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
