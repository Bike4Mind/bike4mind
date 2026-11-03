import { describe, expect, it } from 'vitest';
import { mongoose } from '@bike4mind/database';
import { listSchemaLeaves, listSchemaPaths, looksLikeUserReference, schemaDeclaresPath } from './schemaPaths';

const schema = new mongoose.Schema({
  userId: String,
  title: String,
  profile: new mongoose.Schema({ displayName: String }),
  users: [new mongoose.Schema({ userId: String, permissions: [String] })],
  recipientUserIds: [String],
  extra: mongoose.Schema.Types.Mixed,
});

describe('listSchemaPaths', () => {
  it('descends into subdocuments and arrays of subdocuments', () => {
    expect(listSchemaPaths(schema)).toEqual(
      expect.arrayContaining(['userId', 'profile.displayName', 'users.userId', 'users.permissions', 'recipientUserIds'])
    );
  });
});

describe('schemaDeclaresPath', () => {
  it.each(['userId', 'profile.displayName', 'users.userId', 'recipientUserIds', 'extra.anything.below'])(
    'accepts %s',
    path => {
      expect(schemaDeclaresPath(schema, path)).toBe(true);
    }
  );

  it.each(['ownerId', 'users.email', 'title.nested', 'profile.missing'])('rejects %s', path => {
    expect(schemaDeclaresPath(schema, path)).toBe(false);
  });
});

describe('looksLikeUserReference', () => {
  it.each([
    'userId',
    'users.userId',
    'ownerId',
    'actorUserId',
    'recipientUserIds',
    'createdBy',
    'revokedBy',
    'userEmail',
    'memberIds',
    'participants',
    'receiverName',
    'created_by',
    'permissions.canWrite',
    'sharedWith',
    'billingContact',
    'uid',
    'author.id',
    'adminUserId',
  ])('flags %s', path => {
    expect(looksLikeUserReference(path)).toBe(true);
  });

  it.each([
    'title',
    'organizationId',
    'sessionId',
    'status',
    'users.permissions',
    'isAdmin',
    'cancelledAt',
    'items.id',
    'members._id',
  ])('ignores %s', path => {
    expect(looksLikeUserReference(path)).toBe(false);
  });
});

describe('listSchemaLeaves', () => {
  it('marks paths declared as a reference to User, including arrays of them', () => {
    const refSchema = new mongoose.Schema({
      owner: { type: String, ref: 'User' },
      watchers: [{ type: String, ref: 'User' }],
      project: { type: String, ref: 'Project' },
    });
    const refsUser = listSchemaLeaves(refSchema)
      .filter(leaf => leaf.refsUser)
      .map(leaf => leaf.path);
    expect(refsUser.sort()).toEqual(['owner', 'watchers']);
  });
});
