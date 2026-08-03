#!/usr/bin/env npx tsx
/**
 * Integration verification for the node -> artifact link, against REAL Mongo.
 *
 * The unit tests mock the repositories, so they prove the control flow and
 * nothing about the join itself: that `artifact.sourceQuestId` really matches
 * `run.questId`, that the projection returns the fields the wire needs, that
 * `linkArtifacts` actually persists, and that a second read writes nothing.
 * Those are properties of the schema and the query, so they need the database.
 *
 * Needs no deploy - it drives the module directly, so it works on a stage whose
 * stack is behind (which is the situation this was written in).
 *
 *   ./for-env local npx sst shell --stage <stage> -- \
 *     sh -c 'cd apps/client && npx tsx server/questmaster/v5/verifyArtifactLink.integration.ts'
 *
 * Writes only rows tagged with a unique run id and removes them in a finally.
 */

import { connectDB, Artifact, QuestGraph, QuestNode, questNodeRepository } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { linkNodeArtifacts } from './linkNodeArtifacts';
import type { NodeRunSummary } from './reconcileQuestNodes';
import mongoose from 'mongoose';

const RUN = `alink-${Date.now().toString(36)}`;
const QUEST_ID = `${RUN}-quest`;
const EXEC_ID = new mongoose.Types.ObjectId().toString();

const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(m),
  warn: (m: string) => logs.push(m),
  error: (m: string) => logs.push(m),
  debug: () => {},
} as never;

let failures = 0;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` -- ${detail}` : ''}`);
  if (!cond) failures++;
};

const runs = (questId: string | null): Map<string, NodeRunSummary> =>
  new Map([
    [
      EXEC_ID,
      {
        id: EXEC_ID,
        questId,
        status: 'completed',
        answer: null, // deliberately null: the settle path must not depend on it
        totalIterations: 1,
        totalCreditsUsed: 1,
        errorMessage: null,
        completedAt: new Date(),
      },
    ],
  ]);

async function run() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
  console.log(`connected to stage '${Config.STAGE}'. run ${RUN}\n`);

  const graph = await QuestGraph.create({ goal: `${RUN} goal`, userId: `${RUN}-user` });
  const node = await questNodeRepository.addNode({ graphId: graph.id, title: 'n', task: 'do it' });
  await questNodeRepository.setExecution(node.id, { agentExecutionId: EXEC_ID });

  // Two artifacts shaped exactly as persistAgentArtifacts writes them.
  const artifactFixture = (id: string, type: string, title: string) => ({
    id,
    type,
    title,
    sourceQuestId: QUEST_ID,
    userId: `${RUN}-user`,
    version: 1,
    // Required by the schema; the join under test touches none of them.
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'fixture',
    contentSize: 1,
    permissions: { canRead: [], canWrite: [], canDelete: [], isPublic: false, inheritFromProject: true },
  });
  await Artifact.create([
    artifactFixture(`${RUN}-art-1`, 'react', 'Counter'),
    artifactFixture(`${RUN}-art-2`, 'code', 'Helper'),
  ]);

  console.log('1. the run -> artifact join resolves against real rows');
  const fresh = (await questNodeRepository.getNode(node.id))!;
  const first = await linkNodeArtifacts([fresh], runs(QUEST_ID), logger);
  const found = first.get(node.id) ?? [];
  check('both artifacts found for the node', found.length === 2, `got ${found.length}`);
  check('projection carries type and title', Boolean(found[0]?.type && found[0]?.title), JSON.stringify(found[0]));

  console.log('\n2. the ids are persisted onto the node');
  const linked = (await questNodeRepository.getNode(node.id))!;
  check('artifactIds written', linked.artifactIds.length === 2, `got ${linked.artifactIds.length}`);

  console.log('\n3. a second read writes nothing but still renders');
  const before = (await QuestNode.findById(node.id).lean<{ updatedAt: Date }>())!.updatedAt.getTime();
  const second = await linkNodeArtifacts([linked], runs(QUEST_ID), logger);
  const after = (await QuestNode.findById(node.id).lean<{ updatedAt: Date }>())!.updatedAt.getTime();
  check('still returns them for display', (second.get(node.id) ?? []).length === 2);
  check('no write on a steady-state read', before === after, 'updatedAt moved');

  console.log('\n4. a run with no quest id is a no-op');
  const none = await linkNodeArtifacts([linked], runs(null), logger);
  check('nothing returned', none.size === 0);

  console.log('\n5. the index the join relies on exists');
  const idx = await Artifact.collection.indexes();
  check(
    'sourceQuestId is indexed exactly once',
    idx.filter(i => JSON.stringify(i.key) === JSON.stringify({ sourceQuestId: 1 })).length === 1,
    JSON.stringify(idx.map(i => i.key))
  );
}

async function cleanup() {
  // Scoped to THIS run's graph. An earlier version filtered on `{ title: 'n' }`,
  // which would have matched any node anyone else had named the same - never
  // write a cleanup filter that is not keyed to the run's own ids.
  await Artifact.deleteMany({ sourceQuestId: QUEST_ID });
  const graphs = await QuestGraph.find({ goal: `${RUN} goal` }, { _id: 1 }).lean<Array<{ _id: unknown }>>();
  const graphIds = graphs.map(g => String(g._id));
  if (graphIds.length) await QuestNode.deleteMany({ graphId: { $in: graphIds } });
  await QuestGraph.deleteMany({ goal: `${RUN} goal` });
  console.log('\ncleaned up');
}

run()
  .catch(err => {
    failures++;
    console.error('\nERROR:', err instanceof Error ? err.message : String(err));
  })
  .finally(async () => {
    await cleanup().catch(e => console.error('cleanup failed:', e));
    await mongoose.disconnect();
    console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
