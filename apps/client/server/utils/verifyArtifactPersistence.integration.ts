#!/usr/bin/env npx tsx
/**
 * Integration verification for server-side agent artifact persistence (PR #286),
 * against REAL Mongo and the REAL `artifactService.create`.
 *
 * The unit tests use a fake store, which can only prove the logic is
 * self-consistent. The two defects this PR fixes are both properties of the
 * *storage layer*:
 *   - `artifactService.create` writes artifact_contents -> artifact_versions ->
 *     artifacts with no transaction, so a crash midway wedges that artifact
 *     forever behind an E11000 on the { artifactId, version } unique index;
 *   - the two terminal write paths pass different reply text, so ids differ and
 *     an id-keyed dedup lets both through.
 * Neither is provable against a mock of the thing that has the bug. This drives
 * the real module against the real index.
 *
 * It is also the only way to exercise the orphan-repair path at all: that state
 * is unreachable through the HTTP API (DELETE /api/artifacts/:id only sets
 * deletedAt on the artifacts row, and the generic findOne does not filter it, so
 * artifactExists still returns true and the run skips).
 *
 * Run inside an SST shell so `Resource.MONGODB_URI` resolves:
 *
 *   ./for-env local npx sst shell --stage erikbethke -- \
 *     npx tsx apps/client/server/utils/verifyArtifactPersistence.integration.ts
 *
 * Writes only rows tagged with a unique run id and deletes them in a finally
 * block, so a failure mid-run still cleans up after itself.
 */

import { connectDB, Artifact, ArtifactContent, ArtifactVersion } from '@bike4mind/database';
import { persistAgentArtifacts, buildAgentArtifactPayloads } from './persistAgentArtifacts';
import { Config } from '@server/utils/config';
import mongoose from 'mongoose';

const RUN = `itest-${Date.now().toString(36)}`;
const USER_ID = `${RUN}-user`;
const SESSION_ID = `${RUN}-session`;
const QUEST_CREATED_AT_MS = 1_700_000_000_000;

// Quiet logger: this script asserts on database state, not on log output.
const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
  debug: () => {},
} as never;

const artifact = (identifier: string, title = 'Probe') =>
  `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${title}">
export default function Probe() { return <div>hi</div>; }
</artifact>`;

let failures = 0;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? ` -- ${detail}` : ''}`);
  if (!cond) failures++;
};

const rowsForQuest = (questId: string) => Artifact.countDocuments({ sourceQuestId: questId });

async function run() {
  // Same resolution the app uses (baseApi, agentExecutor, ...): the stored URI
  // carries a literal %STAGE% placeholder, so each stage gets its own database
  // inside the shared cluster. Passing it unsubstituted throws "URI malformed",
  // because %ST is not valid percent-encoding.
  const uri = Config.MONGODB_URI.replace('%STAGE%', Config.STAGE);
  await connectDB(uri);
  console.log(`connected to stage '${Config.STAGE}'. run id ${RUN}\n`);

  // -- 1. happy path -------------------------------------------------------
  console.log('1. a reply with one artifact writes exactly one row');
  const q1 = `${RUN}-quest-1`;
  await persistAgentArtifacts({
    replyText: `Here you go.\n\n${artifact('probe-one')}`,
    questId: q1,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: `${RUN}-exec-1`,
    logger,
  });
  check('one artifacts row', (await rowsForQuest(q1)) === 1, `got ${await rowsForQuest(q1)}`);
  const row1 = await Artifact.findOne({ sourceQuestId: q1 }).lean<{ metadata?: { createdFrom?: string } }>();
  check("provenance createdFrom='agent'", row1?.metadata?.createdFrom === 'agent');

  // -- 2. orphan repair ----------------------------------------------------
  // Reproduce the crash state exactly: a content row exists (unique on
  // { artifactId, version }) with no artifacts row behind it. Before the fix,
  // the retry hit E11000, counted it a clean dedup skip, and the artifacts row
  // was never written again on this run or any future one.
  console.log('\n2. an artifact orphaned by a crash mid-create is repaired, not skipped');
  const q2 = `${RUN}-quest-2`;
  const reply2 = artifact('probe-orphan');
  const [payload2] = buildAgentArtifactPayloads({
    replyText: reply2,
    questId: q2,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
  });
  await ArtifactContent.create({
    artifactId: payload2.id,
    version: 1,
    content: 'orphaned by a crashed create',
    contentHash: 'orphan',
    contentSize: 28,
    mimeType: 'text/plain',
    encoding: 'utf8',
  });
  check('precondition: orphan content, no artifacts row', (await rowsForQuest(q2)) === 0);

  await persistAgentArtifacts({
    replyText: reply2,
    questId: q2,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: `${RUN}-exec-2`,
    logger,
  });
  const after2 = await rowsForQuest(q2);
  check('the wedged artifact now has its row', after2 === 1, `got ${after2}`);
  check(
    'exactly one content row (the orphan was cleared, not duplicated)',
    (await ArtifactContent.countDocuments({ artifactId: payload2.id })) === 1
  );

  // -- 3. quest dedup across differing reply text --------------------------
  // The executor's natural completion sends the full post-DAG-bubble reply; the
  // gate-stop handler sends `finalAnswer ?? 'Agent stopped...'`. Different text
  // parses to different identifiers, so every artifact id differs and an
  // id-keyed check cannot see the second write as a duplicate.
  console.log('\n3. a second terminal write with DIFFERENT reply text does not double-write');
  const q3 = `${RUN}-quest-3`;
  const common = {
    questId: q3,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: `${RUN}-exec-3`,
    logger,
  };
  await persistAgentArtifacts({ ...common, replyText: `Done.\n\n${artifact('probe-natural')}` });
  const afterFirst = await rowsForQuest(q3);
  await persistAgentArtifacts({ ...common, replyText: `Agent stopped by user.\n\n${artifact('probe-gatestop')}` });
  const afterSecond = await rowsForQuest(q3);
  check('first write landed one row', afterFirst === 1, `got ${afterFirst}`);
  check('second write added nothing', afterSecond === 1, `got ${afterSecond}`);

  // -- 4. a partially-persisted quest is completed on retry ---------------
  // The regression Copilot caught: gating on a BOOLEAN "quest has artifacts"
  // treats a quest that lost a row to a transient error as finished forever.
  // The REAL shape of that is a retry of the SAME reply text (so the ids are
  // identical) against a quest that is missing one of its rows.
  console.log('\n4. a partially-persisted quest is completed on retry of the same reply');
  const q4 = `${RUN}-quest-4`;
  const reply4 = `${artifact('probe-partial-a', 'A')}\n\n${artifact('probe-partial-b', 'B')}`;
  const common4 = {
    replyText: reply4,
    questId: q4,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: `${RUN}-exec-4`,
    logger,
  };
  await persistAgentArtifacts(common4);
  const full4 = await rowsForQuest(q4);
  // Drop one row to stand in for the write that failed transiently, leaving the
  // quest partially persisted exactly as a swallowed per-artifact error would.
  const victim = await Artifact.findOne({ sourceQuestId: q4 }).lean<{ id: string }>();
  await Artifact.deleteMany({ id: victim!.id });
  await persistAgentArtifacts(common4);
  const healed4 = await rowsForQuest(q4);
  check('both rows written initially', full4 === 2, `got ${full4}`);
  check('the missing row was restored on retry', healed4 === 2, `got ${healed4}`);

  // -- 5. pin the deliberate trade ----------------------------------------
  // When a partial quest is replayed with DIFFERENT reply text, ids shift (the
  // parser indexes by position, so adding an artifact renumbers the others) and
  // the completion pass can write a second copy. That is the accepted trade
  // recorded in the fix: a visible duplicate beats a row that silently never
  // lands. Pinned so nobody "fixes" it back into silent loss.
  console.log('\n5. differing reply text over a partial quest duplicates rather than loses');
  const q5 = `${RUN}-quest-5`;
  const common5 = {
    questId: q5,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: `${RUN}-exec-5`,
    logger,
  };
  await persistAgentArtifacts({ ...common5, replyText: artifact('probe-trade-a', 'A') });
  await persistAgentArtifacts({
    ...common5,
    replyText: `${artifact('probe-trade-a', 'A')}\n\n${artifact('probe-trade-b', 'B')}`,
  });
  const traded = await rowsForQuest(q5);
  check('nothing was lost (>= the 2 artifacts of the wider reply)', traded >= 2, `got ${traded}`);
  check('the duplicate is bounded, not runaway', traded === 3, `got ${traded}`);
}

async function cleanup() {
  const ids = (await Artifact.find({ sessionId: SESSION_ID }, { id: 1 }).lean<Array<{ id: string }>>()).map(a => a.id);
  const extra = [
    ...(
      await ArtifactContent.find({ artifactId: { $regex: `^artifact_react_probe-` } }, { artifactId: 1 }).lean<
        Array<{ artifactId: string }>
      >()
    ).map(c => c.artifactId),
  ];
  const all = [...new Set([...ids, ...extra])];
  if (all.length) {
    await Artifact.deleteMany({ id: { $in: all } });
    await ArtifactContent.deleteMany({ artifactId: { $in: all } });
    await ArtifactVersion.deleteMany({ artifactId: { $in: all } });
  }
  console.log(`\ncleaned up ${all.length} artifact id(s) from this run`);
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
