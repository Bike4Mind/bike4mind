import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { InviteType } from '@bike4mind/common';
import { Invite, Organization, Project, User } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * GET /api/users publicView for a non-admin is the add-member picker. Against a real mongod, this
 * pins what it may return: people sharing an organization or project with the caller, matched by
 * name/username prefix, plus a user outside that scope only on an exact, fully typed email - and
 * that row is id + name only. No row ever carries an email for a non-admin.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const oid = () => new mongoose.Types.ObjectId();
const REQUESTER = oid();
const ORG_COLLEAGUE = oid();
const PROJECT_COLLEAGUE = oid();
const STRANGER = oid();
const ADMIN = oid();
const ORG = oid();
const PROJECT = oid();

const STRANGER_EMAIL = 'zephyr.stranger@example.test';

interface PickerRow {
  id: string;
  name?: string;
  username?: string;
  email?: string;
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await import('../index');

  // Raw inserts: the picker reads only identity fields, and the full schemas' required fields are
  // irrelevant here. Every user shares the "zephyr" prefix so a prefix search reaches all of them.
  const user = (_id: mongoose.Types.ObjectId, handle: string, isAdmin = false) => ({
    _id,
    name: `Zephyr ${handle}`,
    username: `zephyr_${handle}`,
    email: `zephyr.${handle}@example.test`,
    isAdmin,
  });
  await User.collection.insertMany([
    user(REQUESTER, 'requester'),
    user(ORG_COLLEAGUE, 'orgmate'),
    user(PROJECT_COLLEAGUE, 'projectmate'),
    user(STRANGER, 'stranger'),
    user(ADMIN, 'admin', true),
  ]);
  await Organization.collection.insertOne({
    _id: ORG,
    name: 'Shared org',
    userId: ORG_COLLEAGUE.toString(),
    users: [{ userId: REQUESTER.toString(), permissions: ['read'] }],
    deletedAt: null,
  });
  await Project.collection.insertOne({
    _id: PROJECT,
    name: 'Shared project',
    userId: REQUESTER.toString(),
    users: [{ userId: PROJECT_COLLEAGUE.toString(), permissions: ['read'] }],
    deletedAt: null,
  });
  // One open invite (stored in a different case than the account) and one expired invite.
  await Invite.collection.insertMany([
    {
      type: InviteType.Project,
      documentId: PROJECT.toString(),
      userId: REQUESTER.toString(),
      remaining: 1,
      recipients: { pending: ['ZEPHYR.ORGMATE@example.test'], accepted: [], refused: [] },
      expiresAt: null,
    },
    {
      type: InviteType.Project,
      documentId: PROJECT.toString(),
      userId: REQUESTER.toString(),
      remaining: 1,
      recipients: { pending: [STRANGER_EMAIL], accepted: [], refused: [] },
      expiresAt: new Date(Date.now() - 60_000),
    },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

async function search(caller: mongoose.Types.ObjectId, isAdmin: boolean, query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query: { publicView: 'true', ...query } });
  (req as unknown as { user: unknown }).user = { id: caller.toString(), groups: [], isAdmin };
  await mockRefs.getHandler!(req, res);
  expect(res._getStatusCode()).toBe(200);
  // Round-trip through JSON so the assertions see exactly what the client receives.
  return JSON.parse(JSON.stringify(res._getJSONData().users)) as PickerRow[];
}

const ids = (rows: PickerRow[]) => rows.map(r => r.id).sort();

describe('GET /api/users publicView - non-admin picker scope (real mongod)', () => {
  it('returns org and project colleagues by prefix, never a stranger', async () => {
    const rows = await search(REQUESTER, false, { search: 'zep' });
    expect(ids(rows)).toEqual([REQUESTER, ORG_COLLEAGUE, PROJECT_COLLEAGUE].map(String).sort());
  });

  it('does not reach a stranger through a username or email prefix either', async () => {
    expect(ids(await search(REQUESTER, false, { search: 'zephyr_str' }))).toEqual([]);
    expect(ids(await search(REQUESTER, false, { search: 'zephyr.str' }))).toEqual([]);
    expect(ids(await search(REQUESTER, false, { search: 'zephyr.stranger@example' }))).toEqual([]);
  });

  it('never returns an email to a non-admin', async () => {
    const rows = await search(REQUESTER, false, { search: 'zep' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('email');
  });

  it('keeps username on in-scope rows', async () => {
    const rows = await search(REQUESTER, false, { search: 'zep' });
    expect(rows.find(r => r.id === ORG_COLLEAGUE.toString())?.username).toBe('zephyr_orgmate');
  });

  it('finds a stranger on an exact full email, returning id and name only', async () => {
    const rows = await search(REQUESTER, false, { search: STRANGER_EMAIL.toUpperCase() });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(STRANGER.toString());
    expect(rows[0].name).toBe('Zephyr stranger');
    expect(rows[0]).not.toHaveProperty('email');
    expect(rows[0]).not.toHaveProperty('username');
  });

  it('returns only the picker fields, not schema defaults for unprojected paths', async () => {
    expect(Object.keys((await search(REQUESTER, false, { search: STRANGER_EMAIL }))[0]).sort()).toEqual(['id', 'name']);
    const inScope = await search(REQUESTER, false, { search: 'zep' });
    for (const row of inScope) expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
  });

  it('ignores orgSearch for a non-admin, so it cannot reveal an exact-email match organization', async () => {
    const rows = await search(REQUESTER, false, { search: STRANGER_EMAIL, 'orgSearch[0]': 'No such org' });
    expect(ids(rows)).toEqual([STRANGER.toString()]);
  });

  it('a projectId roster carries no email for a non-admin', async () => {
    const rows = await search(REQUESTER, false, { projectId: PROJECT.toString() });
    expect(ids(rows)).toEqual([PROJECT_COLLEAGUE.toString()]);
    for (const row of rows) expect(row).not.toHaveProperty('email');
  });

  it('leaves admin results unchanged: whole directory, with email', async () => {
    const rows = await search(ADMIN, true, { search: 'zep' });
    expect(ids(rows)).toEqual([REQUESTER, ORG_COLLEAGUE, PROJECT_COLLEAGUE, STRANGER, ADMIN].map(String).sort());
    expect(rows.find(r => r.id === STRANGER.toString())?.email).toBe(STRANGER_EMAIL);
  });

  it('flags open project invitees with pendingInvite, without returning their email', async () => {
    const rows = await search(REQUESTER, false, { search: 'zep', pendingInviteProjectId: PROJECT.toString() });
    const flags = Object.fromEntries(rows.map(r => [r.id, (r as { pendingInvite?: boolean }).pendingInvite]));
    expect(flags).toEqual({
      [REQUESTER.toString()]: false,
      [ORG_COLLEAGUE.toString()]: true,
      [PROJECT_COLLEAGUE.toString()]: false,
    });
    for (const row of rows) expect(row).not.toHaveProperty('email');
  });

  it('does not flag an expired invite', async () => {
    const rows = await search(REQUESTER, false, { search: STRANGER_EMAIL, pendingInviteProjectId: PROJECT.toString() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: STRANGER.toString(), name: 'Zephyr stranger', pendingInvite: false });
    expect(rows[0]).not.toHaveProperty('email');
    expect(rows[0]).not.toHaveProperty('username');
  });

  it('omits pendingInvite for a caller without share access, but still answers the search', async () => {
    const rows = await search(ORG_COLLEAGUE, false, { search: 'zep', pendingInviteProjectId: PROJECT.toString() });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('pendingInvite');
  });
});
