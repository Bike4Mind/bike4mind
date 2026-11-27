// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { IUserDocument } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { Organization, Project, Session, User, organizationRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
import route from '../../pages/api/users/[id]/index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const handler = route as (req: unknown, res: unknown) => Promise<unknown>;
let server: Awaited<ReturnType<typeof createMongoServer>>;
let viewer: Pick<IUserDocument, 'id' | 'groups'>;
let subject: Pick<IUserDocument, 'id'>;
const DETAIL_FIELDS = ['isOnline', 'lastActiveAt', 'level', 'role', 'team'];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Project.collection.deleteMany({}),
    Session.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
  ]);
  viewer = await User.create({ name: 'Viewer', username: 'viewer', groups: ['viewer-group'] });
  subject = await User.create({
    name: 'Subject',
    username: 'subject',
    groups: ['subject-group'],
    role: 'Engineer',
    team: 'Research',
    isOnline: true,
    lastActiveAt: new Date(),
  });
});
afterEach(() => vi.restoreAllMocks());

async function response() {
  const { req, res } = createMocks({ method: 'GET', query: { id: subject.id } });
  Object.assign(req, { user: viewer });
  await handler(req, res);
  return z.record(z.string(), z.unknown()).parse(res._getJSONData());
}

function expectVisibility(payload: Record<string, unknown>, details: boolean) {
  expect(payload).toMatchObject({ id: subject.id, name: 'Subject', username: 'subject', photoUrl: null });
  for (const field of DETAIL_FIELDS) {
    if (details) expect(payload).toHaveProperty(field);
    else expect(payload).not.toHaveProperty(field);
  }
  for (const field of ['email', 'groups', 'isAdmin', 'counters']) expect(payload).not.toHaveProperty(field);
}

describe('public profile colleague scope (real Mongo)', () => {
  it('keeps unrelated users at identity-only visibility', async () => {
    expectVisibility(await response(), false);
  });

  it.each([false, true])('honors shared organization membership; deleted=%s', async deleted => {
    await Organization.collection.insertOne({
      name: 'Shared',
      userId: viewer.id,
      users: [{ userId: subject.id, permissions: ['read'] }],
      deletedAt: deleted ? new Date() : null,
    });
    expectVisibility(await response(), !deleted);
  });

  it.each(['project', 'notebook'] as const)('requires both participants on the same %s', async kind => {
    const collection = mongoose.connection.collection(
      kind === 'project' ? Project.collection.name : Session.collection.name
    );
    await collection.insertMany([
      { userId: 'other-owner', users: [{ userId: viewer.id, permissions: ['read'] }], deletedAt: null },
      { userId: 'other-owner', users: [{ userId: subject.id, permissions: ['read'] }], deletedAt: null },
    ]);
    expectVisibility(await response(), false);
    await collection.insertOne({
      userId: viewer.id,
      users: [{ userId: subject.id, permissions: ['read'] }],
      deletedAt: null,
    });
    expectVisibility(await response(), true);
  });

  it.each(['project', 'notebook'] as const)('ignores a deleted shared %s', async kind => {
    const collection = mongoose.connection.collection(
      kind === 'project' ? Project.collection.name : Session.collection.name
    );
    await collection.insertOne({
      userId: viewer.id,
      users: [{ userId: subject.id, permissions: ['read'] }],
      deletedAt: new Date(),
    });
    expectVisibility(await response(), false);
  });

  it.each(['project', 'notebook'] as const)('uses permission-bearing group shares on a %s', async kind => {
    const collection = mongoose.connection.collection(
      kind === 'project' ? Project.collection.name : Session.collection.name
    );
    await collection.insertOne({
      userId: 'other-owner',
      groups: [
        { groupId: 'viewer-group', permissions: ['read'] },
        { groupId: 'subject-group', permissions: ['write'] },
      ],
      deletedAt: null,
    });
    expectVisibility(await response(), true);
  });

  it('does not turn global notebook visibility into colleague status', async () => {
    await Session.collection.insertOne({
      userId: 'other-owner',
      isGlobalRead: true,
      isGlobalWrite: true,
      deletedAt: null,
    });
    expectVisibility(await response(), false);
  });

  it.each(['membership', 'project', 'notebook'] as const)('fails closed when the %s lookup rejects', async lookup => {
    const failure = new Error('Workspace lookup unavailable');
    if (lookup === 'membership')
      vi.spyOn(organizationRepository, 'findMembershipOrgIds').mockRejectedValueOnce(failure);
    else if (lookup === 'project') vi.spyOn(Project, 'exists').mockRejectedValueOnce(failure);
    else vi.spyOn(Session, 'exists').mockRejectedValueOnce(failure);
    const { req, res } = createMocks({ method: 'GET', query: { id: subject.id } });
    Object.assign(req, { user: viewer });
    await expect(handler(req, res)).rejects.toBe(failure);
    expect(res._getData()).toBe('');
  });
});
