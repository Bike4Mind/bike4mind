import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { InviteType, Permission } from '@bike4mind/common';
import { Invite, Project, User } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Project invites store recipients as addresses, resolved server-side from whatever the inviter sent.
 * Against a real mongod, this pins that the sharer-facing invite routes only ever show back an address
 * the viewer typed: a recipient named by user id comes back as that id plus a name, a legacy row
 * (no typedRecipients) shows no address to a non-admin, and a platform admin's view is unchanged.
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  postHandler: null as null | Handler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

// Transactions need a replica set, and transactionality is not what is under test here.
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return { ...actual, withTransaction: (fn: () => unknown) => fn() };
});
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

const oid = () => new mongoose.Types.ObjectId();
const INVITER = oid();
const CO_SHARER = oid();
const TARGET = oid();
const FRIEND = oid();
const ADMIN = oid();
const PROJECT = oid();

const TARGET_EMAIL = 'target.person@example.test';
const FRIEND_EMAIL = 'friend.person@example.test';
const GHOST_EMAIL = 'ghost@nowhere.test';

interface InviteView {
  id: string;
  recipients: { pending: string[]; accepted: string[]; refused: string[] };
  recipientUsers?: { userId: string; name: string }[];
  typedRecipients?: unknown;
  token?: unknown;
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  await import('../invites');

  const user = (_id: mongoose.Types.ObjectId, name: string, email: string, isAdmin = false) => ({
    _id,
    name,
    username: name.toLowerCase().replace(/\s+/g, '_'),
    email,
    isAdmin,
  });
  await User.collection.insertMany([
    user(INVITER, 'Inviter', 'inviter@example.test'),
    user(CO_SHARER, 'Co Sharer', 'cosharer@example.test'),
    user(TARGET, 'Target Person', TARGET_EMAIL),
    user(FRIEND, 'Friend Person', FRIEND_EMAIL),
    user(ADMIN, 'Admin', 'admin@example.test', true),
  ]);
  await Project.collection.insertOne({
    _id: PROJECT,
    name: 'Free project',
    userId: INVITER.toString(),
    // The list is share-gated with no platform-admin bypass, so the admin view needs share too.
    users: [
      { userId: CO_SHARER.toString(), permissions: [Permission.read, Permission.share] },
      { userId: ADMIN.toString(), permissions: [Permission.read, Permission.share] },
    ],
    groups: [],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Invite.deleteMany({});
});

const actor = (id: mongoose.Types.ObjectId, email: string, isAdmin = false) => ({
  id: id.toString(),
  _id: id,
  email,
  username: 'actor',
  groups: [],
  isAdmin,
});
const inviter = actor(INVITER, 'inviter@example.test');
const coSharer = actor(CO_SHARER, 'cosharer@example.test');
const admin = actor(ADMIN, 'admin@example.test', true);

const json = <T>(res: { _getJSONData: () => unknown }) => JSON.parse(JSON.stringify(res._getJSONData())) as T;

async function invite(recipients: string[]): Promise<InviteView> {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: PROJECT.toString() },
    body: { permissions: [Permission.read], recipients },
  });
  (req as unknown as { user: unknown }).user = inviter;
  await mockRefs.postHandler!(req, res);
  expect(res._getStatusCode()).toBe(200);
  return json<InviteView>(res);
}

async function list(viewer: ReturnType<typeof actor>): Promise<InviteView[]> {
  const { req, res } = createMocks({ method: 'GET', query: { id: PROJECT.toString() } });
  (req as unknown as { user: unknown }).user = viewer;
  await mockRefs.getHandler!(req, res);
  expect(res._getStatusCode()).toBe(200);
  return json<{ data: InviteView[] }>(res).data;
}

const pendingOf = (views: InviteView[]) => views.flatMap(view => view.recipients.pending).sort();

describe('project invite recipients (real mongod)', () => {
  it('never returns the address of a recipient invited by user id, on create or on list', async () => {
    const created = await invite([TARGET.toString()]);

    expect(created.recipients.pending).toEqual([TARGET.toString()]);
    expect(created.recipientUsers).toEqual([{ userId: TARGET.toString(), name: 'Target Person' }]);
    expect(JSON.stringify(created)).not.toContain(TARGET_EMAIL);

    const listed = await list(inviter);
    expect(pendingOf(listed)).toEqual([TARGET.toString()]);
    expect(JSON.stringify(listed)).not.toContain(TARGET_EMAIL);

    // The stored row still holds the address: accept and the invitee's inbox key on it.
    const stored = await Invite.findById(created.id).lean();
    expect(stored?.recipients?.pending).toEqual([TARGET_EMAIL]);
    expect(stored?.typedRecipients).toEqual([]);
  });

  it('shows a typed address back to the inviter who typed it', async () => {
    const created = await invite([FRIEND_EMAIL.toUpperCase()]);
    expect(created.recipients.pending).toEqual([FRIEND_EMAIL]);

    expect(pendingOf(await list(inviter))).toEqual([FRIEND_EMAIL]);
  });

  it('withholds a typed address from a co-sharer who did not type it', async () => {
    await invite([FRIEND_EMAIL]);

    const listed = await list(coSharer);
    expect(pendingOf(listed)).toEqual([FRIEND.toString()]);
    expect(JSON.stringify(listed)).not.toContain(FRIEND_EMAIL);
  });

  it('never ships typedRecipients or the bearer token', async () => {
    const created = await invite([FRIEND_EMAIL, TARGET.toString()]);
    expect(created).not.toHaveProperty('typedRecipients');
    expect(created).not.toHaveProperty('token');
    for (const view of await list(inviter)) {
      expect(view).not.toHaveProperty('typedRecipients');
      expect(view).not.toHaveProperty('token');
    }
  });

  it('leaves the platform admin view unchanged', async () => {
    await invite([FRIEND_EMAIL, TARGET.toString()]);

    expect(pendingOf(await list(admin))).toEqual([FRIEND_EMAIL, TARGET_EMAIL].sort());
  });

  it('shows no address from a legacy row to a non-admin: an id where one resolves, else masked', async () => {
    await Invite.collection.insertOne({
      type: InviteType.Project,
      documentId: PROJECT.toString(),
      permissions: [Permission.read],
      remaining: 2,
      accepted: 0,
      recipients: { pending: [TARGET_EMAIL, GHOST_EMAIL], accepted: [], refused: [] },
      inviterId: INVITER.toString(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const [view] = await list(inviter);
    expect(view.recipients.pending).toEqual([TARGET.toString(), 'g***@nowhere.test']);
    expect(view.recipientUsers).toEqual([{ userId: TARGET.toString(), name: 'Target Person' }]);

    expect(pendingOf(await list(admin))).toEqual([GHOST_EMAIL, TARGET_EMAIL].sort());
  });
});
