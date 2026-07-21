import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB } from '../utils/mongo';
import { createMongoServer } from './createMongoServer';
import mongoose from 'mongoose';
import { beforeAll, afterAll, beforeEach } from 'vitest';
// Import models to ensure they're registered
import { Artifact } from '../models/content/ArtifactModel';
import { ArtifactContent } from '../models/content/ArtifactContentModel';
import { ArtifactVersion } from '../models/content/ArtifactVersionModel';
import { FabFile } from '../models/content/FabFileModel';
import { researchTaskRepository } from '../models/ai/ResearchTaskModel';
import { taskScheduleRepository } from '../models/infra/ops/TaskScheduleModel';
import { researchAgentRepository } from '../models/ai/ResearchAgentModel';

export const connectTestDB = async () => {
  const mongoServer = await createMongoServer();
  const mongoUri = mongoServer.getUri();
  await connectDB(mongoUri);

  return mongoServer;
};

export const disconnectTestDB = async (mongoServer: MongoMemoryServer) => {
  await mongoose.disconnect();
  await mongoServer.stop();
};

export const cleanupTestDB = async () => {
  if (mongoose.connection.db) {
    await mongoose.connection.db.dropDatabase();
  }
};

export async function setupMongoTest() {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();

    // Ensure all indexes are created before running tests
    // This is critical for unique constraints and text search to work properly
    await Promise.all([
      Artifact.ensureIndexes(),
      ArtifactContent.ensureIndexes(),
      ArtifactVersion.ensureIndexes(),
      FabFile.ensureIndexes(),
      // Repositories have no ensureIndexes; importing them registers the mongoose models.
    ]);

    // Force the models to be registered by accessing them
    await Promise.resolve([researchTaskRepository, taskScheduleRepository, researchAgentRepository]);
    // 60s (not 30s): under parallel shards a cold mongodb-memory-server start - binary
    // resolution plus the port-collision retry loop in createMongoServer - can exceed
    // 30s and time the hook out (a transient red, not a real failure).
  }, 60000);

  afterAll(async () => {
    if (mongoServer) {
      await disconnectTestDB(mongoServer);
    }
  }, 30000); // Increase timeout for cleanup

  beforeEach(async () => {
    await cleanupTestDB();
  });
}
