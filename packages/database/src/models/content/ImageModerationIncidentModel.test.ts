import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ImageModerationIncident, imageModerationIncidentRepository } from './ImageModerationIncidentModel';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('ImageModerationIncident model (#9776 Q2a)', () => {
  it('records an incident with labels', async () => {
    const doc = await imageModerationIncidentRepository.record({
      userId: 'u1',
      sessionId: 's1',
      questId: 'q1',
      provider: 'bfl',
      model: 'flux-pro-1.1',
      labels: [{ name: 'Explicit Nudity', parentName: '', confidence: 98.5 }],
    });

    expect(doc.id).toBeTruthy();
    expect(doc.model).toBe('flux-pro-1.1');
    expect(doc.labels[0].name).toBe('Explicit Nudity');

    const found = await ImageModerationIncident.findById(doc.id);
    expect(found?.userId).toBe('u1');
    expect(found?.model).toBe('flux-pro-1.1');
  });

  it('records an upload incident with fabFileId (#9776 Q2b)', async () => {
    const doc = await imageModerationIncidentRepository.record({
      userId: 'u1',
      fabFileId: 'fab123',
      provider: 'upload',
      model: 'upload',
      labels: [{ name: 'Explicit', parentName: '', confidence: 98 }],
    });
    const found = await ImageModerationIncident.findById(doc.id);
    expect(found?.fabFileId).toBe('fab123');
  });
});
