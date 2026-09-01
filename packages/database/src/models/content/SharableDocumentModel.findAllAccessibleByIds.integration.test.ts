import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { IUserDocument, KnowledgeType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';
import { Project, projectRepository } from './ProjectModel';
import { Session, sessionRepository } from '../auth/SessionModel';
import { Agent, agentRepository } from '../ai/AgentModel';
import { Skill, skillRepository } from '../ai/SkillModel';
import { Tool, toolRepository } from '../ai/ToolModel';
import { Organization, organizationRepository } from '../infra/admin/OrganizationModel';

/**
 * Real server, because the behaviour under test is Mongo's casting: an unguarded
 * `_id: { $in: [...] }` rejects the whole query, and /api/files/byIds turns that CastError into a
 * 404 on the notebook file list. Stubs would encode the assumption instead of checking it.
 *
 * Every model below shares ONE `findAllAccessibleByIds` on ShareableDocumentRepository, so the
 * guard lands on all of them at once - including the lookups no manual pass exercises. They are
 * covered here rather than by hand for exactly that reason.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

// A real user id, i.e. an ObjectId hex string. It has to be castable: ToolModel declares
// `userId` as an ObjectId ref, so the `$or: [{ userId: user.id }]` ACL clause casts it too, and a
// non-hex owner would throw there for reasons unrelated to the `_id` guard under test.
const OWNER = '67cbd75e2415ca84138fada7';
// The shape a session row written before the id filtering can still hold.
const JUNK_ID = 'legacy-uuid-not-an-objectid';

const user = { id: OWNER, groups: [] } as unknown as IUserDocument;

// Each `it` seeds its own row, and several of these models carry a unique (name, userId) index -
// `projects.userId_1_name_1`, `skills.name_1_userId_1` - so a fixed name makes the second insert
// in a describe fail with E11000. Unique per call, not per model.
let seq = 0;
const uniqueName = (base: string) => `${base} ${++seq}`;

/** One owned row per model, plus the repository whose shareable guard resolves it. */
const cases: Array<{ name: string; create: () => Promise<string>; find: (ids: string[]) => Promise<unknown[]> }> = [
  {
    name: 'FabFile',
    create: async () => {
      const d = await FabFile.create({
        userId: OWNER,
        fileName: `live-${++seq}.txt`,
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
        fileSize: 4,
      });
      return String(d._id);
    },
    find: ids => fabFileRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Session',
    create: async () => {
      const d = await Session.create({
        name: uniqueName('live session'),
        userId: OWNER,
        lastUpdated: new Date(),
        firstCreated: new Date(),
      });
      return String(d._id);
    },
    find: ids => sessionRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Project',
    create: async () => {
      const d = await Project.create({ name: uniqueName('live project'), description: 'd', userId: OWNER });
      return String(d._id);
    },
    find: ids => projectRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Agent',
    create: async () => {
      const d = await Agent.create({ name: uniqueName('live agent'), description: 'd', userId: OWNER });
      return String(d._id);
    },
    find: ids => agentRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Skill',
    create: async () => {
      const d = await Skill.create({ name: uniqueName('live skill'), description: 'd', body: 'b', userId: OWNER });
      return String(d._id);
    },
    find: ids => skillRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Tool',
    create: async () => {
      // userId is an ObjectId ref here, unlike the string userId the other models use.
      const d = await Tool.create({
        name: uniqueName('live tool'),
        userId: new mongoose.Types.ObjectId(OWNER),
        workBenchFiles: [],
        llmParams: {},
      });
      return String(d._id);
    },
    find: ids => toolRepository.shareable.findAllAccessibleByIds(user, ids),
  },
  {
    name: 'Organization',
    create: async () => {
      const d = await Organization.create({ name: uniqueName('live org'), userId: OWNER });
      return String(d._id);
    },
    find: ids => organizationRepository.shareable.findAllAccessibleByIds(user, ids),
  },
];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build the indexes before any insert. Mongoose creates them in the background, so without this
  // the unique (name, userId) constraints on projects and skills may not exist yet when the first
  // test inserts - which is why the E11000 this guards against reproduced only in CI. Limited to
  // these two models: Session carries a partial index the in-memory server rejects outright.
  await Promise.all([Project, Skill].map(m => m.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe.each(cases)('findAllAccessibleByIds - $name', ({ create, find }) => {
  it('resolves the row when every id is castable', async () => {
    const liveId = await create();
    const rows = (await find([liveId])) as Array<{ id: string }>;
    expect(rows.map(r => String(r.id))).toEqual([liveId]);
  });

  it('keeps the valid row when one id cannot address a row by _id', async () => {
    const liveId = await create();
    const rows = (await find([JUNK_ID, liveId])) as Array<{ id: string }>;
    expect(rows.map(r => String(r.id))).toEqual([liveId]);
  });

  it('matches nothing rather than throwing when every id is unusable', async () => {
    await create();
    const rows = await find([JUNK_ID]);
    expect(rows).toEqual([]);
  });
});
