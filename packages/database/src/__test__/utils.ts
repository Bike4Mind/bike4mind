import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB } from '../utils/mongo';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from './createMongoServer';
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

// This hook does strictly more than boot mongod: it also builds four models' index sets on a cold
// connection, and both costs scale with how contended the runner is. A bare literal here would also
// override any per-file `vi.setConfig` budget, so it is derived from the shared lever rather than
// pinned beside it. Doubled because the shared budget covers booting mongod alone; raising the
// shared constant instead would hand the same slack to every suite that only boots.
const SETUP_HOOK_TIMEOUT_MS = MONGO_TEST_TIMEOUT_MS * 2;

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
  }, SETUP_HOOK_TIMEOUT_MS);

  // No timeout literal: this hook inherits the package's hookTimeout, which is larger than any
  // number that would fit here. The literal this replaces HALVED it under a comment claiming the
  // opposite.
  afterAll(async () => {
    if (mongoServer) {
      await disconnectTestDB(mongoServer);
    }
  });

  beforeEach(async () => {
    await cleanupTestDB();
  });
}
