import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { ApiKeyScope, hasAdminPermission } from '@bike4mind/common';
import { ownerWithheldUsers, persistedIsAdmin, requesterScopedUsers, withholdAdminRole } from './apiKeyAdminScope';

const TestUser = mongoose.model(
  'ApiKeyAdminScopeTestUser',
  new mongoose.Schema({ name: String, isAdmin: { type: Boolean, default: false }, adminPermissions: [String] })
);

const loaded = () =>
  TestUser.hydrate({ _id: new mongoose.Types.ObjectId(), name: 'a', isAdmin: true, adminPermissions: [] });

describe('withholdAdminRole', () => {
  it('reads false on a document without changing what it would persist', () => {
    const doc = loaded();

    withholdAdminRole(doc);

    expect(doc.isAdmin).toBe(false);
    expect(doc.get('isAdmin')).toBe(true);
    expect(doc.isModified('isAdmin')).toBe(false);
    expect(doc.toJSON().isAdmin).toBe(true);
    expect(persistedIsAdmin(doc)).toBe(true);
  });

  it('forwards an explicit write to the document', () => {
    const doc = loaded();
    withholdAdminRole(doc);

    doc.isAdmin = false;

    expect(doc.get('isAdmin')).toBe(false);
    expect(doc.isModified('isAdmin')).toBe(true);
  });

  it('never puts isAdmin in the update a save would send', () => {
    const doc = loaded();
    withholdAdminRole(doc);
    doc.name = 'renamed';

    const delta = (
      doc as unknown as { $__delta: () => [unknown, { $set?: Record<string, unknown> }] | undefined }
    ).$__delta();

    expect(delta?.[1].$set).toEqual({ name: 'renamed' });
  });

  it('is a no-op when applied twice', () => {
    const doc = loaded();

    withholdAdminRole(withholdAdminRole(doc));

    expect(doc.isAdmin).toBe(false);
    expect(doc.get('isAdmin')).toBe(true);
    expect(persistedIsAdmin(doc)).toBe(true);
  });

  it('withholds granular permissions without changing persistence or inventing a full admin', () => {
    const doc = TestUser.hydrate({ isAdmin: false, adminPermissions: ['settings:manage'] });
    withholdAdminRole(doc);
    expect(hasAdminPermission(doc, 'settings:manage')).toBe(false);
    expect(doc.get('adminPermissions')).toEqual(['settings:manage']);
    expect(doc.isModified('adminPermissions')).toBe(false);
    expect(persistedIsAdmin(doc)).toBe(false);
  });

  it('leaves a regular user untouched', () => {
    const user = { id: 'u1', isAdmin: false };
    expect(withholdAdminRole(user)).toEqual({ id: 'u1', isAdmin: false });
    expect(persistedIsAdmin(user)).toBe(false);
  });
});

describe('requesterScopedUsers', () => {
  const repo = {
    findById: vi.fn(async (id: string) => ({ id, isAdmin: true })),
    count: vi.fn(async () => 3),
  };

  it('withholds the role only on the requester read for a key without the admin scope', async () => {
    const users = requesterScopedUsers({ user: { id: 'me' }, apiKeyInfo: { scopes: [ApiKeyScope.WRITE_FILES] } }, repo);

    expect((await users.findById('me'))?.isAdmin).toBe(false);
    expect((await users.findById('other'))?.isAdmin).toBe(true);
    expect(await users.count()).toBe(3);
  });

  it('returns the adapter unchanged for an admin-scoped key or a session', () => {
    expect(requesterScopedUsers({ user: { id: 'me' }, apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] } }, repo)).toBe(repo);
    expect(requesterScopedUsers({ user: { id: 'me' } }, repo)).toBe(repo);
  });
});

describe('ownerWithheldUsers', () => {
  it('keeps Model statics working, hydrate() included', () => {
    const doc = ownerWithheldUsers('me', TestUser).hydrate({
      _id: new mongoose.Types.ObjectId(),
      name: 'a',
      isAdmin: true,
    });

    expect(doc.name).toBe('a');
    expect(doc.isAdmin).toBe(true);
  });

  it('passes an own function-valued field such as a repository model through untouched', () => {
    class Repo {
      constructor(public model: typeof TestUser) {}
      async findById() {
        return null;
      }
    }

    expect(ownerWithheldUsers('me', new Repo(TestUser)).model).toBe(TestUser);
  });
});
