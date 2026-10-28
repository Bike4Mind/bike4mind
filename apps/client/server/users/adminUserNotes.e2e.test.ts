import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { Request } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { AdminUserNoteModel, AdminUserNoteRevisionModel, AdminAuditLogModel, User } from '@bike4mind/database';
import { listAdminUserNotes, writeAdminUserNote } from './adminUserNotes';
import { listUserTimeline } from '../utils/userTimeline';
import { recordAdminActionFromRequest } from '../utils/adminAudit';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('../utils/adminAudit', async importOriginal => {
  const original = await importOriginal<typeof import('../utils/adminAudit')>();
  return { ...original, recordAdminActionFromRequest: vi.fn(original.recordAdminActionFromRequest) };
});
const USER = '650000000000000000000001';
const ADMIN = '650000000000000000000002';
let server: MongoMemoryReplSet;
const request = (
  method: string,
  body: unknown = {},
  query: Record<string, unknown> = {},
  identity = { id: ADMIN, name: 'Test Admin', username: 'admin', isAdmin: true, adminPermissions: [] as string[] }
) =>
  ({
    method,
    body,
    query: { userId: USER, ...query },
    user: identity,
    headers: {},
    url: `/api/admin/users/${USER}/notes`,
  }) as unknown as Request;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await AdminUserNoteRevisionModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  vi.mocked(recordAdminActionFromRequest).mockClear();
  for (const model of [AdminUserNoteModel, AdminUserNoteRevisionModel, AdminAuditLogModel, User])
    await model.collection.deleteMany({});
  await User.collection.insertOne({ _id: new Types.ObjectId(USER), name: 'Synthetic user', tags: [] });
});

describe('admin user notes storage, service and timeline', () => {
  it('retains attributed versions across edit, delete and restore without exporting text', async () => {
    const note = await writeAdminUserNote(request('POST', { body: '<b>private context</b>' }));
    const edited = await writeAdminUserNote(request('PATCH', { noteId: note.id, version: 1, body: 'Updated context' }));
    const deleted = await writeAdminUserNote(request('PATCH', { noteId: note.id, version: 2, deleted: true }));
    expect((await listAdminUserNotes(request('GET'))).entries).toEqual([]);
    await writeAdminUserNote(request('PATCH', { noteId: note.id, version: 3, deleted: false }));
    const history = await listAdminUserNotes(request('GET', {}, { noteId: note.id }));
    expect(history.entries.map(row => row.version)).toEqual([4, 3, 2, 1]);
    expect(history.entries[3].body).toBe('<b>private context</b>');
    expect(edited.author.id).toBe(ADMIN);
    expect(deleted.deleted).toBe(true);
    const timeline = await listUserTimeline(
      { id: USER, name: 'Synthetic user', isAdmin: false },
      { types: ['admin'], limit: 50, range: {} }
    );
    expect(timeline.entries).toHaveLength(4);
    expect(timeline.entries.map(row => ('audit' in row ? row.audit.action : ''))).toContain('user.note.edited');
    expect(JSON.stringify(timeline)).not.toContain('private context');
    expect(JSON.stringify(timeline)).not.toContain('Updated context');
    await expect(
      AdminUserNoteRevisionModel.updateOne({ noteId: note.id }, { $set: { body: 'overwrite' } })
    ).rejects.toThrow('immutable');
  });
  it('rejects concurrent edits rather than losing a revision', async () => {
    const note = await writeAdminUserNote(request('POST', { body: 'Original' }));
    const results = await Promise.allSettled(
      ['First', 'Second'].map(body => writeAdminUserNote(request('PATCH', { noteId: note.id, version: 1, body })))
    );
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    expect(await AdminUserNoteRevisionModel.countDocuments({ noteId: note.id })).toBe(2);
  });
  it('rolls back the mutation and revision when the strict audit fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('Synthetic audit failure'));
    await expect(writeAdminUserNote(request('POST', { body: 'Must roll back' }))).rejects.toThrow(
      'Synthetic audit failure'
    );
    expect(await AdminUserNoteModel.countDocuments()).toBe(0);
    expect(await AdminUserNoteRevisionModel.countDocuments()).toBe(0);
  });
  it('denies ordinary users and read-only delegates before mutation', async () => {
    const reader = {
      id: ADMIN,
      name: 'Reader',
      username: 'reader',
      isAdmin: false,
      adminPermissions: ['support:read'],
    };
    await expect(writeAdminUserNote(request('POST', { body: 'Denied' }, {}, reader))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(listAdminUserNotes(request('GET', {}, {}, { ...reader, adminPermissions: [] }))).rejects.toMatchObject(
      { statusCode: 403 }
    );
    expect(await AdminUserNoteModel.countDocuments()).toBe(0);
  });
  it('bounds text, pagination and target ids and scopes every note to its subject', async () => {
    await expect(writeAdminUserNote(request('POST', { body: 'x'.repeat(2001) }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(listAdminUserNotes(request('GET', {}, { limit: '51' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(listAdminUserNotes(request('GET', {}, { userId: 'bad' }))).rejects.toMatchObject({ statusCode: 400 });
    const a = await writeAdminUserNote(request('POST', { body: 'Older' }));
    const b = await writeAdminUserNote(request('POST', { body: 'Newer' }));
    const page = await listAdminUserNotes(request('GET', {}, { limit: '1' }));
    expect(page.entries.map(row => row.id)).toEqual([b.id]);
    expect(
      (await listAdminUserNotes(request('GET', {}, { limit: '1', cursor: page.nextCursor }))).entries.map(row => row.id)
    ).toEqual([a.id]);
    await AdminUserNoteModel.updateOne({ _id: a.id }, { $set: { userId: '650000000000000000000009' } });
    await expect(
      writeAdminUserNote(request('PATCH', { noteId: '650000000000000000000099', version: 1, body: 'Unknown' }))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
