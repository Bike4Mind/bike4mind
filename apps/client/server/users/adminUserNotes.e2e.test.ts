import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
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

const routes = vi.hoisted(() => ({
  patch: undefined as undefined | ((req: Request, res: Response) => Promise<unknown>),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      patch: (fn: typeof routes.patch) => {
        routes.patch = fn;
        return chain;
      },
    };
    return chain;
  },
}));
await import('../../pages/api/admin/users/[userId]/tags');

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
  it('rejects impersonated note writes without persisting text or audit entries', async () => {
    const req = request('POST', { body: 'Must not be saved' });
    req.user.impersonatedBy = ADMIN;
    await expect(writeAdminUserNote(req)).rejects.toMatchObject({ statusCode: 403 });
    expect(await AdminUserNoteModel.countDocuments()).toBe(0);
    expect(await AdminUserNoteRevisionModel.countDocuments()).toBe(0);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });
  it('rejects deletion and bulk rewriting of revision history', async () => {
    const note = await writeAdminUserNote(request('POST', { body: 'Retained history' }));
    await expect(AdminUserNoteRevisionModel.deleteMany({ noteId: note.id })).rejects.toThrow('immutable');
    await expect(
      AdminUserNoteRevisionModel.bulkWrite([{ deleteMany: { filter: { noteId: note.id } } }])
    ).rejects.toThrow('immutable');
    expect(await AdminUserNoteRevisionModel.countDocuments({ noteId: note.id })).toBe(1);
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
    const otherId = '650000000000000000000009';
    await User.collection.insertOne({ _id: new Types.ObjectId(otherId), name: 'Other synthetic user' });
    await expect(
      writeAdminUserNote(request('PATCH', { noteId: a.id, version: 1, body: 'Wrong subject' }, { userId: otherId }))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await listAdminUserNotes(request('GET', {}, { userId: otherId, noteId: a.id }))).entries).toEqual([]);
    await expect(
      writeAdminUserNote(request('PATCH', { noteId: '650000000000000000000099', version: 1, body: 'Unknown' }))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('atomically writes tags and their timeline audit, refuses stale changes, and rolls back failed auditing', async () => {
    const writeTags = async (before: string[], tags: string[]) => {
      const { res } = createMocks();
      await routes.patch!(request('PATCH', { before, tags }), res as unknown as Response);
    };
    await writeTags([], ['pilot']);
    const timeline = await listUserTimeline(
      { id: USER, name: 'Synthetic user', isAdmin: false },
      { types: ['admin'], limit: 50, range: {} }
    );
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({ audit: { action: 'user.tags.updated', actor: { userId: ADMIN } } });
    await expect(writeTags([], ['stale'])).rejects.toMatchObject({ statusCode: 409 });
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('Synthetic tag audit failure'));
    await expect(writeTags(['pilot'], ['must-not-stick'])).rejects.toThrow('Synthetic tag audit failure');
    expect((await User.findById(USER).lean())?.tags).toEqual(['pilot']);
  });
  it('replaces raw legacy tag snapshots without weakening stale-write protection', async () => {
    const before = [' vip ', 'pilot', 'PILOT', 'x'.repeat(65), ...Array.from({ length: 101 }, (_, i) => `tag${i}`)];
    await User.updateOne({ _id: USER }, { $set: { tags: before } });
    const { res } = createMocks();
    await routes.patch!(request('PATCH', { before, tags: ['vip'] }), res as unknown as Response);
    expect((await User.findById(USER).lean())?.tags).toEqual(['vip']);
    await expect(
      routes.patch!(request('PATCH', { before, tags: [] }), res as unknown as Response)
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
