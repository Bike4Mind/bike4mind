import { describe, expect, it } from 'vitest';
import { mongoose } from '@bike4mind/database';
import { listSchemaPaths, looksLikeUserReference, schemaDeclaresPath } from './schemaPaths';

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
  ])('flags %s', path => {
    expect(looksLikeUserReference(path)).toBe(true);
  });

  it.each(['title', 'organizationId', 'sessionId', 'status', 'users.permissions'])('ignores %s', path => {
    expect(looksLikeUserReference(path)).toBe(false);
  });
});
