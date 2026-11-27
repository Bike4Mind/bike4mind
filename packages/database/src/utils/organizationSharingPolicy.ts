import { Schema } from 'mongoose';
import {
  EXTERNAL_SHARING_BLOCKED,
  ForbiddenError,
  isOrgMember,
  organizationAllowsRecipient,
  organizationSharingPolicy,
  PUBLIC_SHARING_BLOCKED,
  type IOrganizationDocument,
  type UserShareGrant,
  type OrganizationShareRecipient,
} from '@bike4mind/common';

type BoundContent = {
  organizationId?: string;
  userId?: string;
  isGlobalRead?: boolean;
  isGlobalWrite?: boolean;
  visibility?: string;
  permissions?: { isPublic?: boolean; canRead?: string[]; canWrite?: string[]; canDelete?: string[] };
  users?: Array<{ userId: string }>;
  groups?: Array<{ groupId: string }>;
  sessionId?: string;
  projectId?: string;
  sessionIds?: string[];
  fileIds?: string[];
};

async function loadOrganization(id: string): Promise<IOrganizationDocument> {
  const { organizationRepository } = await import('../models/infra/admin/OrganizationModel');
  const organization = await organizationRepository.findById(id);
  if (!organization) throw new ForbiddenError('The content organization is unavailable.');
  return organization;
}

export async function assertOrganizationRecipients(
  organizationId: string | undefined,
  recipients: OrganizationShareRecipient[]
): Promise<void> {
  if (!organizationId) return;
  const org = await loadOrganization(organizationId);
  if (recipients.some(recipient => !organizationAllowsRecipient(org, recipient))) {
    throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
  }
}

export async function assertOrganizationPublicLink(organizationId: string | undefined): Promise<void> {
  if (!organizationId) return;
  const policy = organizationSharingPolicy(await loadOrganization(organizationId));
  if (!policy.allowPublicLinks) throw new ForbiddenError(PUBLIC_SHARING_BLOCKED);
  if (!policy.allowExternalSharing) throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
}

export async function assertOrganizationUserGrants(content: BoundContent, grants: UserShareGrant[]): Promise<void> {
  if (!content.organizationId || !grants.length) return;
  const { userRepository } = await import('../models/auth/UserModel');
  const users = await userRepository.findByIds(grants.map(grant => grant.userId));
  const byId = new Map(users.map(user => [String(user.id), user]));
  await assertOrganizationRecipients(
    content.organizationId,
    grants.map(grant => ({
      id: grant.userId,
      email: byId.get(grant.userId)?.email,
      emailVerified: byId.get(grant.userId)?.emailVerified,
    }))
  );
}

const recipientIds = (content: BoundContent): string[] => [
  ...(content.users ?? []).map(user => user.userId),
  ...(content.permissions?.canRead ?? []),
  ...(content.permissions?.canWrite ?? []),
  ...(content.permissions?.canDelete ?? []),
];

async function assertContentSharing(content: BoundContent, previous: BoundContent = {}): Promise<void> {
  if (!content.organizationId) return;
  if (
    (content.isGlobalRead && !previous.isGlobalRead) ||
    (content.isGlobalWrite && !previous.isGlobalWrite) ||
    (content.visibility === 'public' && previous.visibility !== 'public') ||
    (content.permissions?.isPublic && !previous.permissions?.isPublic)
  ) {
    await assertOrganizationPublicLink(content.organizationId);
  }
  const previousIds = new Set(recipientIds(previous));
  const ids = new Set(recipientIds(content).filter(id => !previousIds.has(id)));
  await assertOrganizationUserGrants(
    content,
    [...ids].map(userId => ({ userId, permissions: [] }))
  );
  const groups = content.groups?.filter(row => !previous.groups?.some(old => old.groupId === row.groupId));
  if (groups?.length) {
    const org = await loadOrganization(content.organizationId);
    if (!organizationSharingPolicy(org).allowExternalSharing) {
      const { groupRepository } = await import('../models/social/GroupModel');
      for (const row of groups) {
        const group = await groupRepository.findById(row.groupId);
        if (!group || String(group.organizationId) !== content.organizationId) {
          throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
        }
      }
    }
  }
}

export async function assertProjectContentGrants(content: BoundContent, recipientUserIds: string[]): Promise<void> {
  if (!recipientUserIds.length) return;
  const { sessionRepository } = await import('../models/auth/SessionModel');
  const { fabFileRepository } = await import('../models/content/FabFileModel');
  const sessions = content.sessionIds?.length ? await sessionRepository.findAllByIds(content.sessionIds) : [];
  const files = content.fileIds?.length ? await fabFileRepository.findAllByIds(content.fileIds) : [];
  const grants = recipientUserIds.map(userId => ({ userId, permissions: [] }));
  for (const child of [...sessions, ...files]) await assertOrganizationUserGrants(child, grants);
}

const SHARING_KEYS = [
  'users',
  'groups',
  'permissions',
  'visibility',
  'isGlobalRead',
  'isGlobalWrite',
  'sessionIds',
  'fileIds',
];
// The one repository pipeline performs recipient checks before constructing its atomic merge.
// Query identity keeps that exception local to the checked write, rather than an ambient bypass.
const checkedSharingQueries = new WeakSet<object>();
export function checkedOrganizationSharingQuery<Query extends object>(query: Query): Query {
  checkedSharingQueries.add(query);
  return query;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Operators that only remove or clear values; they can never widen a share, so they pass unchecked.
const NARROWING_OPERATORS = new Set(['$pull', '$pullAll', '$pop', '$unset']);

const touchesSharingKey = (changes: Record<string, unknown>): boolean =>
  Object.keys(changes).some(key => SHARING_KEYS.some(field => key === field || key.startsWith(`${field}.`)));

/**
 * The fields an update sets: `$set` plus top-level plain keys, which Mongoose also applies as `$set`.
 * Any other widening operator on a sharing key ($push, $addToSet, $rename, ...) is refused, since the
 * policy check reads only set values.
 */
function readableSharingChanges(update: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith('$')) changes[key] = value;
    else if (key === '$set' && isRecord(value)) Object.assign(changes, value);
    else if (
      key === '$rename' &&
      isRecord(value) &&
      Object.values(value).some(
        destination =>
          typeof destination === 'string' &&
          (destination === 'organizationId' || touchesSharingKey({ [destination]: true }))
      )
    ) {
      throw new ForbiddenError('Sharing fields cannot be rename destinations.');
    } else if (
      !NARROWING_OPERATORS.has(key) &&
      value &&
      typeof value === 'object' &&
      touchesSharingKey(value as Record<string, unknown>)
    ) {
      throw new ForbiddenError(`Sharing fields can only be changed with $set, not ${key}.`);
    }
  }
  if (
    Object.keys(changes).some(
      key =>
        key.includes('.') &&
        SHARING_KEYS.some(field => key.startsWith(`${field}.`)) &&
        !(key.startsWith('permissions.') && key.split('.').length === 2)
    )
  )
    throw new ForbiddenError('Sharing arrays must be replaced as a whole.');
  return changes;
}

// Supported model writes are checked here; the atomic grant pipeline checks before marking its query.
export function organizationContentPolicyPlugin(schema: Schema): void {
  schema.pre('save', async function () {
    const content = this.toObject() as BoundContent;
    if (this.isNew && (content.sessionId || content.projectId)) {
      const { sessionRepository } = await import('../models/auth/SessionModel');
      const { projectRepository } = await import('../models/content/ProjectModel');
      const session = content.sessionId ? await sessionRepository.findById(content.sessionId) : null;
      const project = content.projectId ? await projectRepository.findById(content.projectId) : null;
      const inherited = session?.organizationId ?? project?.organizationId;
      if (inherited) {
        content.organizationId = inherited;
        this.set('organizationId', inherited);
      }
    }
    if (this.isNew && content.organizationId) {
      const org = await loadOrganization(content.organizationId);
      if (!content.userId || !isOrgMember({ id: content.userId }, org)) {
        throw new ForbiddenError('You are not a member of the selected organization.');
      }
    }
    if (
      this.isNew ||
      ['users', 'groups', 'permissions', 'visibility', 'isGlobalRead', 'isGlobalWrite'].some(key =>
        this.isModified(key)
      )
    ) {
      const previous = this.isNew ? undefined : await this.$model().findById(this._id).lean<BoundContent>();
      await assertContentSharing(content, previous ?? {});
    }
    if (this.isNew && (content.sessionIds?.length || content.fileIds?.length)) {
      await assertProjectContentGrants(content, [
        ...recipientIds(content),
        ...(content.userId ? [content.userId] : []),
      ]);
    }
  });
  schema.pre(['updateOne', 'findOneAndUpdate'], async function () {
    if (checkedSharingQueries.has(this)) return;
    const changes = sharingChangesOf(this.getUpdate());
    if (!changes) return;
    const current = await this.model.findOne(this.getFilter()).lean<BoundContent>();
    if (current) await assertSharingChange(current, changes);
  });
  schema.pre('updateMany', async function () {
    if (checkedSharingQueries.has(this)) return;
    const changes = sharingChangesOf(this.getUpdate());
    if (!changes) return;
    for (const current of await this.model.find(this.getFilter()).lean<BoundContent[]>()) {
      await assertSharingChange(current, changes);
    }
  });
  schema.pre('bulkWrite', function (next, operations: unknown[]) {
    for (const operation of operations) {
      if (!isRecord(operation)) continue;
      for (const kind of ['updateOne', 'updateMany']) {
        const write = operation[kind];
        if (isRecord(write) && sharingChangesOf(write.update)) {
          throw new ForbiddenError('Sharing fields cannot be changed through bulkWrite; use a checked model update.');
        }
      }
      if (operation.replaceOne) throw new ForbiddenError('Content replacement is not supported through bulkWrite.');
      const insert = operation.insertOne;
      if (
        isRecord(insert) &&
        isRecord(insert.document) &&
        (insert.document.organizationId || touchesSharingKey(insert.document))
      ) {
        throw new ForbiddenError('Shared or organization-bound content must be created through the model.');
      }
    }
    next();
  });
}

function sharingChangesOf(update: unknown): Record<string, unknown> | null {
  if (Array.isArray(update)) {
    for (const stage of update) {
      if (!isRecord(stage)) throw new ForbiddenError('Unsupported content update pipeline.');
      for (const [operator, fields] of Object.entries(stage)) {
        if (operator === '$unset') {
          const paths = Array.isArray(fields) ? fields : [fields];
          if (paths.includes('organizationId')) throw new ForbiddenError('The content organization is immutable.');
          continue;
        }
        if (
          !['$set', '$addFields'].includes(operator) ||
          !isRecord(fields) ||
          'organizationId' in fields ||
          touchesSharingKey(fields)
        ) {
          throw new ForbiddenError('Sharing fields require a checked update rather than an arbitrary pipeline.');
        }
      }
    }
    return null;
  }
  if (!isRecord(update)) return null;
  const changes = readableSharingChanges(update as Record<string, unknown>);
  return touchesSharingKey(changes) ? changes : null;
}

async function assertSharingChange(current: BoundContent, changes: Record<string, unknown>): Promise<void> {
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (SHARING_KEYS.includes(key)) Object.assign(next, { [key]: value });
    else if (key.startsWith('permissions.')) {
      next.permissions = { ...next.permissions, [key.slice('permissions.'.length)]: value };
    }
  }
  await assertContentSharing(next, current);
  if (changes.sessionIds !== undefined || changes.fileIds !== undefined) {
    await assertProjectContentGrants(
      {
        sessionIds: next.sessionIds?.filter(id => !current.sessionIds?.includes(id)),
        fileIds: next.fileIds?.filter(id => !current.fileIds?.includes(id)),
      },
      [...recipientIds(next), ...(next.userId ? [next.userId] : [])]
    );
  }
}
