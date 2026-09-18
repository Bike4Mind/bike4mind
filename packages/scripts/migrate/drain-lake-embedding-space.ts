/**
 * One-off drain of a data lake's corpus into the platform default embedding space.
 *
 * WHY THIS EXISTS RATHER THAN A ROUTE: `defaultEmbeddingModel` is now text-embedding-3-small while
 * every lake corpus is still ada-002. Forced retrieval embeds the query in the lake's MAJORITY
 * model and `partitionFilesByEmbeddingModel` withholds every file outside it, so a newly ingested
 * 3-small file lands in an ada-002 lake and is served in zero answers. The lake-wide rebuild door
 * (`apps/client/pages/api/data-lakes/[id]/rechunk.ts`) now carries the embedding-space selector
 * this script was written ahead of, so for a lake that HAS a `datalakes` document that door is the
 * durable fix and should be preferred: it holds the right authorization and the right write
 * primitive, and an admin can drive it without a shell.
 *
 * WHY THIS IS STILL HERE RATHER THAN DELETED: that door resolves its lake through
 * `assertLakeAccess`, a `datalakes` collection read, so it can only address a lake that has a
 * document. A REGISTRY lake is a code constant in `b4m-core/common/src/constants/dataLakes.ts` with
 * no row at all - `opti-knowledge`, the largest corpus on the stage, is one - so no `[id]` reaches
 * it and the durable fix cannot drain it by construction. Resolving both kinds (see `lakeIdKind`)
 * is the one capability this script does not share with the door, and it is the reason to keep it.
 *
 * WHAT IT DOES NOT DO: it does not re-embed anything itself. It resets chunk state and enqueues to
 * the same queue the rebuild door uses; the chunk worker deletes the old passages and re-embeds,
 * reading `defaultEmbeddingModel` live. A reset file takes the FRESH path in the chunk handler
 * because the reset clears `chunked` and `noExtractableTextAt`, so `resolveResumeEmbeddingModel`
 * never fires and cannot pin the file back to the space it just left.
 *
 * SCOPE DEVIATION, on purpose: membership here is `metaTag OR prefix` with NO creator anchor on the
 * prefix arm, which is wider than the retrieval predicate for a DB lake (buildDataLakeMembershipQuery
 * anchors that arm to the lake creator). For a drain, converting an extra prefix-tagged file into
 * the default space can only make that file's space agree with more readers, never fewer, and it
 * avoids leaving a file behind in the minority space for a later membership change to surface. The
 * owner allowlist is what bounds the widening: a file owned outside it aborts the run.
 *
 * HOW TO RUN IT (dry run first; --execute is the only writing mode):
 *   ./for-env bike4mind-prod pnpm sst shell --stage production -- \
 *     pnpm --filter @bike4mind/scripts exec tsx migrate/drain-lake-embedding-space.ts --lake ionq-sales
 * `sst shell` and `pnpm --filter` both collapse a non-zero child exit code to 1, so the exit code
 * cannot distinguish "a guard refused" (2) from "it crashed" (1). READ THE OUTPUT, not the status:
 * every refusal prints a line beginning STOP. If the flags do not survive the wrappers the script
 * prints its usage and exits without reading anything, which is a safe failure rather than a
 * silently unscoped run.
 *
 * FILES ARE UNSEARCHABLE BETWEEN RESET AND RE-CHUNK, and partway through a drain the lake's
 * majority flips to the new space and withholds whatever has not converted yet. The lake is
 * degraded in both directions until the pass completes, so run it through rather than trickling,
 * and take the smaller lake first.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connectDB, whenCatalogSeeded, mongoose, FabFile, DataLakeModel, fabFileRepository } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';

/** Must stay in sync with CONVERGENCE_ORIGIN in b4m-core/common/src/constants/convergenceProvenance.ts.
 *  Inlined so this script does not pull the zod-bearing module in for one string literal. */
const CONVERGENCE_ORIGIN = 'convergence';

/** The rebuild door's own wave sizes, from b4m-core/services/src/dataLakeService/rebuildLakePassages.ts. */
const DEFAULT_WAVE = 50;
const MAX_WAVE = 200;

const QUERY_TIMEOUT_MS = 30_000;

type Target = {
  /** What goes in the queue message's `lakeId`, which is what the convergence kill switch reads.
   *  A registry lake's id is its slug; a DB lake's is its document _id, resolved at run time. */
  lakeIdKind: 'registry' | 'db';
  registryId?: string;
  tag: string;
  prefix: string;
  /** Owners measured 2026-09-17. A file owned by anyone else means the unanchored prefix arm
   *  reached outside the population this run was authorized against, so the run aborts. */
  owners: string[];
};

const TARGETS: Record<string, Target> = {
  'ionq-sales': {
    lakeIdKind: 'db',
    tag: 'datalake:ionq-sales',
    prefix: 'ionq:',
    owners: ['6539a090c2f71a8ee2c1bc3a', '69a2373e4e238aae87a391de', '68ed1c53a686dd0cae83e34d'],
  },
  'opti-knowledge': {
    // Static registry lake: defined in b4m-core/common/src/constants/dataLakes.ts, with no
    // `datalakes` row, which is why nothing that enumerates that collection can see it.
    lakeIdKind: 'registry',
    registryId: 'opti-knowledge',
    tag: 'datalake:opti-knowledge',
    prefix: 'opti:',
    owners: ['6539a090c2f71a8ee2c1bc3a', '69a2373e4e238aae87a391de'],
  },
};

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const LAKE = flag('lake');
const EXECUTE = has('execute');
const VERIFY = has('verify');
const LIMIT = flag('limit') ? Number(flag('limit')) : undefined;
const EXPECT = flag('expect') ? Number(flag('expect')) : undefined;
const WAVE = Math.min(flag('wave') ? Number(flag('wave')) : DEFAULT_WAVE, MAX_WAVE);

const str = (v: unknown) => String(v ?? '');

type FileRow = {
  _id: unknown;
  userId?: unknown;
  fileName?: string;
  embeddingModel?: string;
  vectorizedChunkCount?: number;
  isChunking?: boolean;
  chunked?: boolean;
  vectorized?: boolean;
  chunkRebuildRequestedAt?: unknown;
};

const tally = (rows: FileRow[], key: (f: FileRow) => string) => {
  const m = new Map<string, number>();
  for (const f of rows) {
    const k = key(f);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `${v} x${n}`)
    .join(', ');
};

/** 0 = ran, 1 = usage or failure, 2 = a guard refused to proceed (nothing was written). */
async function main(): Promise<number> {
  if (!LAKE || !TARGETS[LAKE]) {
    console.log(
      `usage: --lake <${Object.keys(TARGETS).join('|')}> [--execute --expect N] [--limit N] [--wave N] [--verify]`
    );
    return 1;
  }
  const target = TARGETS[LAKE];

  const dbUri = Resource.MONGODB_URI.value;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  await connectDB(dbUri.replace('%STAGE%', Resource.App.stage));
  const db = mongoose.connection.db;
  if (!db) throw new Error('no database on the mongoose connection');
  console.log(`stage=${Resource.App.stage}  db=${db.databaseName}`);
  console.log(`lake=${LAKE}  mode=${VERIFY ? 'VERIFY' : EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);

  // Settings are read one row at a time BY NAME: this collection also holds live credentials, so
  // an unprojected sweep would pull one into the output.
  const setting = async (name: string) => {
    const row = await db
      .collection('adminsettings')
      .findOne({ settingName: name }, { projection: { settingValue: 1 } });
    return row?.settingValue;
  };

  const defaultModel = str(await setting('defaultEmbeddingModel'));
  if (!defaultModel) {
    console.log('STOP: defaultEmbeddingModel has no row. Refusing to guess the target space.');
    return 2;
  }
  console.log(`defaultEmbeddingModel = ${defaultModel}`);

  // The rebuild door refuses a whole wave when convergence is halted, before touching anything,
  // because a wave halted mid-flight leaves its files with no passages at all. This mirrors only
  // the PLATFORM rung, so a scoped row would make the check incomplete - and scopedsettings was
  // empty at last measurement, which makes a row appearing a reason to stop and re-read.
  const paused = await setting('PauseLakeConvergence');
  const scopedRows = await db.collection('scopedsettings').countDocuments({});
  if (paused) {
    console.log(`STOP: PauseLakeConvergence = ${JSON.stringify(paused)}. Background lake work is paused.`);
    return 2;
  }
  if (scopedRows > 0) {
    console.log(
      `STOP: ${scopedRows} scopedsettings row(s) exist, so this script's platform-only pause check is incomplete.`
    );
    return 2;
  }

  let lakeId = target.registryId ?? '';
  if (target.lakeIdKind === 'db') {
    const lake = await DataLakeModel.findOne({ datalakeTag: target.tag }).maxTimeMS(QUERY_TIMEOUT_MS).lean();
    if (!lake) {
      console.log(`STOP: no datalakes row carries datalakeTag ${target.tag}.`);
      return 2;
    }
    lakeId = str((lake as { _id: unknown })._id);
  }
  console.log(`lakeId stamped on queue messages = ${lakeId}\n`);

  // tags is an array of OBJECTS carrying a name, and deletedAt is explicit because a lean/raw read
  // bypasses the soft-delete find hook.
  const membership = {
    deletedAt: null,
    $or: [
      { tags: { $elemMatch: { name: target.tag } } },
      { tags: { $elemMatch: { name: { $regex: `^${escapeRegex(target.prefix)}` } } } },
    ],
  };

  if (VERIFY) {
    const all = (await FabFile.find(membership, {
      embeddingModel: 1,
      chunked: 1,
      vectorized: 1,
      vectorizedChunkCount: 1,
      chunkRebuildRequestedAt: 1,
    })
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean()) as unknown as FileRow[];

    console.log(`--- ${all.length} member files ---`);
    console.log(`  embeddingModel: ${tally(all, f => f.embeddingModel ?? 'BLANK')}`);
    console.log(`  chunked:        ${tally(all, f => String(!!f.chunked))}`);
    console.log(`  vectorized:     ${tally(all, f => String(!!f.vectorized))}`);
    const inFlight = all.filter(f => f.chunkRebuildRequestedAt && !f.vectorized).length;
    console.log(`  rebuild requested, not yet vectorized: ${inFlight}  (workers still catching up)`);
    const staleFiles = all.filter(f => (f.embeddingModel ?? '') !== defaultModel).length;

    // The file's own label is a STAMP, not the vectors. A file can read 3-small while its passages
    // still hold ada-002 vectors, and that lake looks healthy everywhere while scoring query
    // similarity across two spaces - noise, with no error anywhere. fabfilechunks.fabFileId is a
    // STRING, so joining on ObjectId here returns zero and reads as "no chunks".
    const ids = all.map(f => str(f._id));
    const chunkLabels = await db
      .collection('fabfilechunks')
      .aggregate(
        [
          { $match: { fabFileId: { $in: ids } } },
          { $group: { _id: '$embeddingModel', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ],
        { maxTimeMS: QUERY_TIMEOUT_MS }
      )
      .toArray();
    const chunkTotal = chunkLabels.reduce((n, r) => n + (r.n as number), 0);
    const staleChunks = chunkLabels.filter(r => str(r._id) !== defaultModel).reduce((n, r) => n + (r.n as number), 0);
    console.log(`\n--- ${chunkTotal} passages actually stored for those files ---`);
    console.log(`  chunk embeddingModel: ${chunkLabels.map(r => `${r._id ?? 'BLANK'} x${r.n}`).join(', ')}`);

    // An unlabelled passage is benign or serious depending on one field, and the counts alone
    // cannot tell them apart: with no vector it is simply awaiting embedding and will resolve
    // itself, but WITH a vector it is embedded and unlabelled, which retrieval's space filter
    // cannot see - withheld permanently, with no error raised anywhere.
    const unlabelled = {
      fabFileId: { $in: ids },
      $or: [{ embeddingModel: { $exists: false } }, { embeddingModel: null }, { embeddingModel: '' }],
    };
    const blankTotal = await db.collection('fabfilechunks').countDocuments(unlabelled, { maxTimeMS: QUERY_TIMEOUT_MS });
    if (blankTotal > 0) {
      const blankEmbedded = await db
        .collection('fabfilechunks')
        .countDocuments({ ...unlabelled, 'vector.0': { $exists: true } }, { maxTimeMS: QUERY_TIMEOUT_MS });
      console.log(
        `  of ${blankTotal} unlabelled: ${blankTotal - blankEmbedded} awaiting embedding (benign, re-check),`
      );
      console.log(`     ${blankEmbedded} ALREADY EMBEDDED but unlabelled (a real defect - retrieval cannot see these)`);
    }

    // File-level flags are NOT a completion signal: a drain of this lake showed all 585 files
    // reading vectorized:true while 72% of their passages held no vector at all.
    console.log(`\n  files not in ${defaultModel}:    ${staleFiles}`);
    console.log(`  passages not in ${defaultModel}: ${staleChunks}`);
    console.log('  DRAIN IS COMPLETE WHEN BOTH ARE 0. A zero on the first line alone is a stamp,');
    console.log('  not a re-embed, and the second line is what retrieval actually scores against.');
    return staleFiles === 0 && staleChunks === 0 ? 0 : 2;
  }

  const stale = (await FabFile.find(
    { ...membership, embeddingModel: { $ne: defaultModel } },
    { userId: 1, fileName: 1, embeddingModel: 1, vectorizedChunkCount: 1, isChunking: 1 }
  )
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean()) as unknown as FileRow[];

  const chunkSum = stale.reduce((n, f) => n + (Number(f.vectorizedChunkCount) || 0), 0);
  console.log(`--- population: ${stale.length} files not in ${defaultModel}, ${chunkSum} stored chunks ---`);
  console.log(`  prior labels: ${tally(stale, f => f.embeddingModel ?? 'BLANK')}`);

  const ownerCounts = new Map<string, number>();
  for (const f of stale) {
    const id = str(f.userId);
    ownerCounts.set(id, (ownerCounts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const known = target.owners.includes(id);
    console.log(`  owner ${id} x${n}${known ? '' : '   <-- NOT IN THE AUTHORIZED OWNER LIST'}`);
  }
  if ([...ownerCounts.keys()].some(id => !target.owners.includes(id))) {
    console.log('\nSTOP: the prefix arm reached files owned outside the authorized set. Re-measure and re-authorize.');
    return 2;
  }

  const midRun = stale.filter(f => f.isChunking === true).length;
  if (midRun) {
    console.log(`  note: ${midRun} file(s) are mid-chunk and the reset precondition will skip them`);
  }

  // The manifest goes to the OS temp dir at 0600, never into the working tree: this is a public
  // repo and its history is permanent.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-drain-'));
  const manifest = path.join(outDir, `${LAKE}-manifest.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        stage: Resource.App.stage,
        lake: LAKE,
        lakeId,
        defaultModel,
        files: stale.map(f => ({
          fabFileId: str(f._id),
          userId: str(f.userId),
          fileName: f.fileName ?? null,
          priorEmbeddingModel: f.embeddingModel ?? null,
          priorVectorizedChunkCount: f.vectorizedChunkCount ?? 0,
        })),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  console.log(`\nmanifest of prior state: ${manifest}`);
  console.log('  This is NOT an undo. The worker deletes the old passages, so a drain can only be');
  console.log('  re-run, never reversed; the manifest records which files were touched and from what.');

  if (!EXECUTE) {
    console.log(`\ndry run: nothing written. To execute:\n  --lake ${LAKE} --execute --expect ${stale.length}`);
    return 0;
  }
  if (EXPECT !== stale.length) {
    console.log(`\nSTOP: --expect ${EXPECT ?? '(absent)'} does not match the measured population ${stale.length}.`);
    console.log('Pass the number the dry run printed, so a drifted population aborts instead of draining.');
    return 2;
  }

  const ordered = stale.slice(0, LIMIT ?? stale.length);
  const ownerById = new Map(ordered.map(f => [str(f._id), str(f.userId)] as const));
  console.log(`\nexecuting over ${ordered.length} file(s) in waves of ${WAVE}`);

  const sqs = new SQSClient({});
  const queueUrl = Resource.fabFileChunkQueue.url;
  const resetLog = path.join(outDir, `${LAKE}-reset.log`);
  let resetTotal = 0;
  let sentTotal = 0;
  const failedSends: string[] = [];

  for (let i = 0; i < ordered.length; i += WAVE) {
    const waveIds = ordered.slice(i, i + WAVE).map(f => str(f._id));

    // Reset first, then enqueue exactly what the reset changed. The reset is preconditioned on
    // isChunking:{$ne:true}, so a file a worker holds a lease on is skipped rather than having
    // that lease released, and the returned ids are therefore a subset of the wave.
    const resetIds = await fabFileRepository.resetChunkStateByIds(waveIds);
    resetTotal += resetIds.length;
    fs.appendFileSync(resetLog, resetIds.join('\n') + '\n', { mode: 0o600 });

    // allSettled, not all: one failed send must not abandon the rest of the wave. A reset file
    // whose send never landed reads as chunkless, which is what the daily chunk rescue sweep
    // selects on - so it self-heals, but slowly and against a platform-wide per-run cap. Re-running
    // this script is the faster remedy, since such a file is still in the stale set.
    const results = await Promise.allSettled(
      resetIds.map(id =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({
              fabFileId: id,
              // The FILE OWNER, not whoever runs this: the worker resolves the file through the
              // owner's access, the way the rebuild door does.
              userId: ownerById.get(id),
              // Provenance is what makes an in-flight drain haltable via PauseLakeConvergence.
              // Without it these messages read as user work and cannot be stopped once sent.
              origin: CONVERGENCE_ORIGIN,
              lakeId,
            }),
          })
        )
      )
    );
    let waveSent = 0;
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') waveSent += 1;
      else failedSends.push(resetIds[k]);
    });
    sentTotal += waveSent;
    console.log(`  wave ${Math.floor(i / WAVE) + 1}: reset ${resetIds.length}/${waveIds.length}, enqueued ${waveSent}`);
  }

  console.log(`\nreset ${resetTotal} file(s), enqueued ${sentTotal}.`);
  console.log(`reset ids: ${resetLog}`);
  if (failedSends.length) {
    console.log(`  ${failedSends.length} send(s) FAILED - those files are reset but not queued:`);
    for (const id of failedSends.slice(0, 20)) console.log(`    ${id}`);
    if (failedSends.length > 20) console.log(`    ... and ${failedSends.length - 20} more (see the reset log)`);
    console.log('  re-run this script to pick them up.');
  }
  console.log(`\nWorkers re-embed asynchronously. Confirm convergence with:\n  --lake ${LAKE} --verify`);
  return failedSends.length ? 2 : 0;
}

/**
 * `process.exitCode` + an explicit disconnect, never `process.exit()`: Node's stdout is
 * asynchronous when it is a pipe, which the `sst shell` invocation guarantees, and `process.exit()`
 * does not drain it. The last lines printed are the manifest path, the reset-log path and the
 * failed-send list - exactly what an operator needs to finish or re-run a partial drain.
 */
void (async () => {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    // connectDB (priceCatalogBootstrap) kicks off a fire-and-forget catalog seed. Disconnecting
    // under it throws MongoExpiredSessionError and dumps a stack trace AFTER the report, burying
    // the lines above. whenCatalogSeeded never rejects.
    await whenCatalogSeeded().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
})();
