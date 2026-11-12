import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../__test__/createMongoServer';
import { Organization } from '../models/infra/admin/OrganizationModel';
import { Project, projectRepository } from '../models/content/ProjectModel';
import { Session } from '../models/auth/SessionModel';
import { assertOrganizationPublicLink } from './organizationSharingPolicy';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all([
    Organization.collection.deleteMany({}),
    Project.collection.deleteMany({}),
    Session.collection.deleteMany({}),
  ]);
});

async function seed() {
  return Organization.create({
    name: 'Team',
    userId: 'owner',
    personal: false,
    users: [{ userId: 'member', permissions: ['read'] }],
    sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: [] },
  });
}

describe('persisted organization sharing boundary', () => {
  it('validates prospective project and notebook ownership', async () => {
    const org = await seed();
    await expect(Project.create({ name: 'forged', userId: 'outsider', organizationId: org.id })).rejects.toThrow(
      'not a member'
    );
    await expect(
      Session.create({
        name: 'forged',
        userId: 'outsider',
        organizationId: org.id,
        firstCreated: new Date(),
        lastUpdated: new Date(),
      })
    ).rejects.toThrow('not a member');
    const project = await Project.create({ name: 'bound', userId: 'member', organizationId: org.id });
    await Project.updateOne({ _id: project.id }, { $set: { organizationId: 'different' } });
    expect((await Project.findById(project.id))?.organizationId).toBe(org.id);
  });
  it('refuses public flags and public links before a write', async () => {
    const org = await seed();
    const session = await Session.create({
      name: 'bound',
      userId: 'owner',
      organizationId: org.id,
      firstCreated: new Date(),
      lastUpdated: new Date(),
    });
    await expect(Session.findOneAndUpdate({ _id: session.id }, { $set: { isGlobalRead: true } })).rejects.toThrow(
      'public links'
    );
    expect((await Session.findById(session.id))?.isGlobalRead).toBe(false);
    await expect(assertOrganizationPublicLink(org.id)).rejects.toThrow('public links');
  });
  it('refuses propagated external project grants, while permitting members', async () => {
    const org = await seed();
    const project = await Project.create({ name: 'bound', userId: 'owner', organizationId: org.id });
    await expect(
      projectRepository.shareable.updateUserShares(project.id, { add: [{ userId: 'outsider', permissions: ['read'] }] })
    ).rejects.toThrow('approved email domains');
    expect((await Project.findById(project.id))?.users).toHaveLength(0);
    await projectRepository.shareable.updateUserShares(project.id, {
      add: [{ userId: 'member', permissions: ['read'] }],
    });
    expect((await Project.findById(project.id))?.users).toHaveLength(1);
  });
  it('keeps legacy unbound content personal and shareable', async () => {
    await seed();
    const project = await Project.create({ name: 'personal', userId: 'owner' });
    await projectRepository.shareable.updateUserShares(project.id, {
      add: [{ userId: 'outsider', permissions: ['read'] }],
    });
    expect((await Project.findById(project.id))?.organizationId).toBeUndefined();
    expect((await Project.findById(project.id))?.users).toHaveLength(1);
  });
  it('permits revocation after an organization tightens its policy', async () => {
    const org = await seed();
    const project = await Project.create({ name: 'bound', userId: 'owner', organizationId: org.id });
    await Project.collection.updateOne(
      { _id: project._id },
      {
        $set: {
          users: [
            { userId: 'old-outsider', permissions: ['read'] },
            { userId: 'remove-me', permissions: ['read'] },
          ],
        },
      }
    );
    await Project.findOneAndUpdate(
      { _id: project.id },
      { $set: { users: [{ userId: 'old-outsider', permissions: ['read'] }] } }
    );
    expect((await Project.findById(project.id))?.users.map(user => user.userId)).toEqual(['old-outsider']);
  });
});
