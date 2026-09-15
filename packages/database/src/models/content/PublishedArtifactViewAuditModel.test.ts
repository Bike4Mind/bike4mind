import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import {
  PublishedArtifactViewAuditModel,
  publishedArtifactViewAuditRepository,
} from './PublishedArtifactViewAuditModel';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('PublishedArtifactViewAudit model', () => {
  it('records a domain-gated view with viewer attribution', async () => {
    const doc = await publishedArtifactViewAuditRepository.createLog({
      publicId: 'pub-1',
      viewerId: 'user-1',
      gateKind: 'domain',
      viewerEmailDomain: 'acme.com',
      sourceIp: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    expect(doc.id).toBeTruthy();
    expect(doc.createdAt).toBeInstanceOf(Date);

    const found = await PublishedArtifactViewAuditModel.findById(doc.id);
    expect(found?.publicId).toBe('pub-1');
    expect(found?.viewerId).toBe('user-1');
    expect(found?.gateKind).toBe('domain');
    expect(found?.viewerEmailDomain).toBe('acme.com');
  });

  it('allows optional fields to be omitted', async () => {
    const doc = await publishedArtifactViewAuditRepository.createLog({
      publicId: 'pub-2',
      viewerId: 'user-2',
      gateKind: 'domain',
    });
    const found = await PublishedArtifactViewAuditModel.findById(doc.id);
    expect(found?.viewerEmailDomain).toBeUndefined();
    expect(found?.sourceIp).toBeUndefined();
  });

  it('rejects an unknown gate kind (enum guard)', async () => {
    await expect(
      // @ts-expect-error - deliberately invalid gateKind to assert the schema enum rejects it
      publishedArtifactViewAuditRepository.createLog({ publicId: 'p', viewerId: 'v', gateKind: 'bogus' })
    ).rejects.toThrow();
  });
});
