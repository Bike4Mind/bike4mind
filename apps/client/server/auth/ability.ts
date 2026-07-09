import { ExtractSubjectType, MongoAbility } from '@casl/ability';
import { AbilityBuilder, createMongoAbility, MongoQuery } from '@casl/ability';
import {
  AdminSettings,
  CounterLog,
  Session,
  User,
  Invite,
  Prompt,
  UserActivityCounter,
  FeedbackModel,
  ModalModel,
  Organization,
  FabFile,
  Memento,
  Project,
  QuestMasterPlan,
} from '@bike4mind/database';
import { InvitePermission, IUserDocument, Permission, hasDeveloperUserTag } from '@bike4mind/common';
import { SecretRotation } from '@bike4mind/database/infra';
import { Subscription } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

export type Ability = MongoAbility;
function defineAbilitiesFor(user: IUserDocument | undefined) {
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

    if (user.isAdmin) {
      allow('create', AdminSettings);
      allow('read', AdminSettings);
      allow('update', AdminSettings);
      allow('delete', AdminSettings);

      allow('create', ModalModel);
      allow('update', ModalModel);
      allow('delete', ModalModel);
      allow('manage', ModalModel); // Full management permissions for modal tool
      allow('manage', 'Modal'); // Allow the modal-tool API to check this permission

      allow('read', Organization);
      allow('update', Organization);
      allow('delete', Organization);

      allow('read', UserActivityCounter);
      allow('update', UserActivityCounter);
    }

    allow('read', UserActivityCounter, ownDocumentPermission);
    allow('update', UserActivityCounter, ownDocumentPermission);

    allow('read', ModalModel);

    // Allow all users to read settings, but only admins can modify them
    allow('read', AdminSettings, {
      settingName: {
        $in: ['EnableQuestMaster', 'EnableMementos', 'EnableArtifacts'],
      },
    });
    if (user.isAdmin) {
      allow('update', AdminSettings);
      allow('create', AdminSettings);
      allow('delete', AdminSettings);
    }

    // Common patterns applied to each resource below: own documents, documents
    // shared with the user's ID, and documents shared with any of the user's groups.
    [Session, FabFile, Organization, Project].forEach(resource => {
      allow(Permission.create, resource);

      // Global read/write flags apply to all resource types:
      allow(Permission.read, resource, { isGlobalRead: true });
      allow(Permission.update, resource, { isGlobalWrite: true });

      [Permission.read, Permission.update, Permission.delete, Permission.share].forEach(permission => {
        allow(permission, resource, ownDocumentPermission);

        const userWithPermissions: MongoQuery = {
          'users.userId': user.id,
          'users.permissions': permission,
        };
        const groupWithPermissions: MongoQuery = {
          'groups.groupId': { $in: user.groups },
          'groups.permissions': permission,
        };
        allow(permission, resource, userWithPermissions);

        if (user.groups?.length) {
          allow(permission, resource, groupWithPermissions);
        }
      });
    });

    // Team Manager permissions for Organizations
    // Managers can read and update organizations they manage (but not billing-related fields)
    const managerPermission: MongoQuery = { managerId: user.id };
    allow(Permission.read, Organization, managerPermission);
    allow(Permission.update, Organization, managerPermission);
    allow('addUser', Organization, managerPermission);
    allow('removeUser', Organization, managerPermission);
    allow('export', Session, ownDocumentPermission);
    allow('clone', Session, ownDocumentPermission);

    // QuestMasterPlan read access follows read access to its associated Session (via notebookId)
    allow(Permission.read, QuestMasterPlan, {
      notebookId: {
        $in: Session.find({
          userId: user.id,
        }).select('_id'),
      },
    });

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

    allow(Permission.create, FeedbackModel);

    allow(Permission.update, FeedbackModel, {
      userId: user.id,
    });

    if (user.isAdmin) {
      allow(Permission.read, FeedbackModel);
      allow(Permission.delete, FeedbackModel);
      allow(Permission.update, FeedbackModel);

      allow(Permission.read, SecretRotation);
      allow(Permission.create, SecretRotation);
      allow(Permission.update, SecretRotation);

      allow(Permission.create, Session);
      allow(Permission.delete, Session);
      allow(Permission.update, Session);
      allow('clone', Session);
    }
    allow(Permission.read, Prompt);

    allow(Permission.read, Subscription, {
      ownerType: SubscriptionOwnerType.User,
      ownerId: user.id,
    });

    if (user.isAdmin) {
      allow(Permission.read, Subscription);
    }

    allow(Permission.delete, Memento, { userId: user.id });
    allow('deleteMany', Memento, { userId: user.id });

    // Prompt-library management: admin or developer (internal-staff bypass, matching
    // every other product gate in this codebase - see hasDeveloperUserTag). Previously
    // gated on the literal 'Analyst' tag with NO admin fallback (a codebase outlier);
    // replaced 2026-07-08 after confirming every current holder was already admin AND
    // developer, so this changes nothing for existing users.
    if (user.isAdmin || hasDeveloperUserTag(user.tags)) {
      allow(Permission.create, Prompt);
      allow(Permission.update, Prompt);
      allow(Permission.delete, Prompt);
    }
  }
  return build({
    detectSubjectType: item => item.constructor as ExtractSubjectType<any>,
  });
}

export default defineAbilitiesFor;
