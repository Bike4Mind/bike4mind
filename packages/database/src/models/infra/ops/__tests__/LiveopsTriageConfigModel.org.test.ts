import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { liveopsTriageConfigRepository, LiveopsTriageConfigModel } from '../LiveopsTriageConfigModel';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../__test__/createMongoServer';

describe('LiveopsTriageConfigModel org scoping', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await LiveopsTriageConfigModel.createIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await LiveopsTriageConfigModel.deleteMany({});
  });

  const baseConfig = {
    slackChannelId: 'C0000000001',
    issueTracker: 'github' as const,
    githubOwner: 'owner',
    githubRepo: 'repo',
    modelId: 'test-model',
  };

  it('persists organizationId on create', async () => {
    const config = await liveopsTriageConfigRepository.createConfig({
      ...baseConfig,
      name: 'org-a-config',
      organizationId: 'org-a',
    });

    expect(config.organizationId).toBe('org-a');
  });

  it('legacy configs have no organizationId and remain queryable', async () => {
    await liveopsTriageConfigRepository.createConfig({ ...baseConfig, name: 'legacy-config' });

    const all = await liveopsTriageConfigRepository.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].organizationId).toBeUndefined();
  });

  it('findByOrganizationId returns only that org configs', async () => {
    await liveopsTriageConfigRepository.createConfig({
      ...baseConfig,
      name: 'org-a-config',
      organizationId: 'org-a',
    });
    await liveopsTriageConfigRepository.createConfig({
      ...baseConfig,
      name: 'org-b-config',
      organizationId: 'org-b',
    });
    await liveopsTriageConfigRepository.createConfig({ ...baseConfig, name: 'legacy-config' });

    const orgA = await liveopsTriageConfigRepository.findByOrganizationId('org-a');
    expect(orgA.map(c => c.name)).toEqual(['org-a-config']);

    const orgB = await liveopsTriageConfigRepository.findByOrganizationId('org-b');
    expect(orgB.map(c => c.name)).toEqual(['org-b-config']);
  });

  it('updateConfig can set and clear organizationId', async () => {
    const created = await liveopsTriageConfigRepository.createConfig({ ...baseConfig, name: 'migrating-config' });

    const scoped = await liveopsTriageConfigRepository.updateConfig(created.id, { organizationId: 'org-a' });
    expect(scoped?.organizationId).toBe('org-a');

    const cleared = await liveopsTriageConfigRepository.updateConfig(created.id, { organizationId: null });
    expect(cleared?.organizationId).toBeNull();
  });
});
