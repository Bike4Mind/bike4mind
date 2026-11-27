import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import ResearchDataModel, { researchDataRepository } from './ResearchDataModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = new mongoose.Types.ObjectId().toHexString();
const OTHER = new mongoose.Types.ObjectId().toHexString();
const fabFiles = () => mongoose.connection.collection('fabfiles');

const seedFile = async (userId: unknown) => {
  const _id = new mongoose.Types.ObjectId();
  await fabFiles().insertOne({ _id, userId, fileName: `${_id.toHexString()}.md` });
  return _id.toHexString();
};

const seedRow = (fabFileId: string) =>
  ResearchDataModel.create({ fabFileId, researchTaskId: 'task-1', researchAgentId: 'agent-1', userId: OWNER });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await ResearchDataModel.collection.deleteMany({});
  await fabFiles().deleteMany({});
});

describe('ResearchDataRepository.findAllByResearchTaskIdWithFiles', () => {
  it("joins the owner's files, stored with either id form, and omits a row linking another user's file", async () => {
    const ownString = await seedFile(OWNER);
    const ownObjectId = await seedFile(new mongoose.Types.ObjectId(OWNER));
    const foreign = await seedFile(OTHER);
    await seedRow(ownString);
    await seedRow(ownObjectId);
    await seedRow(foreign);

    const rows = await researchDataRepository.findAllByResearchTaskIdWithFiles('task-1', OWNER);

    expect(rows.map(r => r.fabFile.id).sort()).toEqual([ownString, ownObjectId].sort());
  });
});
