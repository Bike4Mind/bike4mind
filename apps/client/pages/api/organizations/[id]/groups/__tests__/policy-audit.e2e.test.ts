// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import { Organization, OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { Group } from '@bike4mind/database/social';
import { Project } from '@bike4mind/database/content';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const routes = vi.hoisted(() => ({ post: undefined as Handler | undefined, put: undefined as Handler | undefined }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: () => chain,
      post: (handler: Handler) => {
        routes.post = handler;
        return chain;
      },
      put: (handler: Handler) => {
        routes.put = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
import '../index';
import '../[groupId]/projects';

let replica: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await Promise.all([
    Organization.createCollection(),
    Group.createCollection(),
    Project.createCollection(),
    OrganizationAuditEventModel.createCollection(),
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

async function provision(organizationId: string, impersonatedBy?: string) {
  if (!routes.post) throw new Error('Group creation route not registered');
  const { req, res } = createMocks({ method: 'POST', query: { id: organizationId }, body: { type: 'team' } });
  Object.assign(req, { user: { id: 'owner', impersonatedBy } });
  await routes.post(req, res);
  return res;
}
async function share(
  organizationId: string,
  groupId: string,
  projectId: string,
  enabled: boolean,
  impersonatedBy?: string
) {
  if (!routes.put) throw new Error('Project sharing route not registered');
  const { req, res } = createMocks({
    method: 'PUT',
    query: { id: organizationId, groupId },
    body: { projectId, enabled },
  });
  Object.assign(req, { user: { id: 'owner', impersonatedBy } });
  await routes.put(req, res);
  return res;
}
async function seed() {
  const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
  const group = await Group.create({ name: 'Team group', type: 'team', organizationId: organization.id });
  const project = await Project.create({ name: 'Owned project', userId: 'owner', groups: [] });
  return { organization, group, project };
}

describe('group policies and strict organization audit', () => {
  it('commits provisioning with a bounded event attributed to the real actor', async () => {
    const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
    expect((await provision(organization.id, 'real-admin'))._getStatusCode()).toBe(200);
    expect((await Organization.findById(organization.id).lean())?.allowedGroupTypes).toContain('team');
    expect(await Group.countDocuments({ organizationId: organization.id })).toBe(1);
    const event = await OrganizationAuditEventModel.findOne({}).lean();
    expect(event).toMatchObject({
      organizationId: organization.id,
      actorUserId: 'real-admin',
      action: 'policy.updated',
      targetId: 'group-type:team',
    });
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ['_id', 'organizationId', 'actorUserId', 'action', 'targetId', 'occurredAt'].sort()
    );
  });
  it('canonicalizes uppercase organization IDs before provisioning or auditing', async () => {
    const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
    await provision(organization.id.toUpperCase());
    await provision(organization.id);
    expect(await Group.countDocuments({ organizationId: organization.id })).toBe(1);
    expect(await Group.countDocuments({})).toBe(1);
    const events = await OrganizationAuditEventModel.find({}).lean();
    expect(events).toHaveLength(2);
    expect(events.every(event => event.organizationId === organization.id)).toBe(true);
  });
  it('canonicalizes uppercase project and group IDs into an effective, unique grant', async () => {
    const { organization, group, project } = await seed();
    await share(organization.id.toUpperCase(), group.id.toUpperCase(), project.id.toUpperCase(), true);
    await share(organization.id, group.id, project.id, true);
    expect((await Project.findById(project.id).lean())?.groups).toEqual([
      expect.objectContaining({ groupId: group.id, permissions: ['read'] }),
    ]);
    const events = await OrganizationAuditEventModel.find({}).lean();
    expect(events).toHaveLength(2);
    expect(events.every(event => event.organizationId === organization.id && event.targetId === project.id)).toBe(true);
  });
  it('rolls back both the organization grant and provisioned group if the audit cannot persist', async () => {
    const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(provision(organization.id)).rejects.toThrow('audit unavailable');
    expect((await Organization.findById(organization.id).lean())?.allowedGroupTypes ?? []).toEqual([]);
    expect(await Group.countDocuments({})).toBe(0);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it('commits project grants and revocations with the same trusted actor envelope', async () => {
    const { organization, group, project } = await seed();
    expect((await share(organization.id, group.id, project.id, true, 'real-admin'))._getStatusCode()).toBe(200);
    expect((await Project.findById(project.id).lean())?.groups).toEqual([
      expect.objectContaining({ groupId: group.id, permissions: ['read'] }),
    ]);
    await share(organization.id, group.id, project.id, false, 'real-admin');
    expect((await Project.findById(project.id).lean())?.groups).toEqual([]);
    const events = await OrganizationAuditEventModel.find({}).lean();
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event).toMatchObject({
        organizationId: organization.id,
        actorUserId: 'real-admin',
        action: 'policy.updated',
        targetId: project.id,
      });
  });
  it.each([true, false])('rolls back project sharing when enabled=%s and the strict audit fails', async enabled => {
    const { organization, group, project } = await seed();
    const before = enabled ? [] : [{ groupId: group.id, permissions: ['read'] }];
    await Project.updateOne({ _id: project.id }, { $set: { groups: before } });
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(share(organization.id, group.id, project.id, enabled)).rejects.toThrow('audit unavailable');
    const after = (await Project.findById(project.id).lean())?.groups ?? [];
    expect(after.map(group => ({ groupId: group.groupId, permissions: group.permissions }))).toEqual(before);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it('keeps idempotent grants unique while recording each successful apply request', async () => {
    const { organization, group, project } = await seed();
    await share(organization.id, group.id, project.id, true);
    await share(organization.id, group.id, project.id, true);
    expect((await Project.findById(project.id).lean())?.groups).toHaveLength(1);
    expect(
      await OrganizationAuditEventModel.countDocuments({ organizationId: organization.id, targetId: project.id })
    ).toBe(2);
  });
});
