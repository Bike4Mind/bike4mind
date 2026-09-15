#!/usr/bin/env tsx
/**
 * Seed (or clear) the "stranded by the convergence kill switch" marker on one member of a data lake,
 * so a QA environment can exercise the Rebuild passages door.
 *
 * Why this script has to exist: the marker is worker-written by design. The only producer is the
 * chunk handler halting convergence-origin work, and both doors that produce such work (/converge,
 * /rechunk) refuse while the kill switch is ON - so the honest route is a seconds-wide race between
 * starting convergence and flipping the switch, which is not a test procedure. No admin surface
 * writes chunk stall state either. Hence a direct write, kept here rather than pasted as ad-hoc
 * mongosh so the field set stays correct as the markers move.
 *
 * Writes BOTH fields on purpose:
 *   - `chunkStallReason` is the predicate every current reader uses (#2016 moved the markers off
 *     `notes`), and
 *   - `notes` is what a build from before that migration selects on.
 * A deploy can be on either side of it, and a one-field seed silently selects nothing on the other -
 * which reads as "the rebuild door is broken" rather than "the fixture missed". Setting both is
 * harmless on both sides; drop the `notes` write once no live environment predates #2016.
 *
 * Self-verifying: it re-runs the door's own detection query after writing and prints the resulting
 * count, so a mismatched marker fails here instead of during the test.
 *
 * Usage (DB comes from sst):
 *   # list eligible members of the lake, write nothing
 *   npx sst shell --stage <stage> -- tsx packages/scripts/datalake/seed-stranded-lake-member.ts \
 *     --lake <lakeId>
 *
 *   # plan the seed (dry run), then apply it
 *   ... --lake <lakeId> --fabFileId <fabFileId>
 *   ... --lake <lakeId> --fabFileId <fabFileId> --execute
 *
 *   # undo it
 *   ... --lake <lakeId> --fabFileId <fabFileId> --clear --execute
 *
 * Idempotent, so re-run it to re-seed between test steps: a successful rebuild CLEARS the marker
 * (that clearing is the behaviour under test), which is why the guide needs the seed twice.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  connectDB,
  DataLakeModel,
  FabFile,
  buildDataLakeMembershipQuery,
  fabFileRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { CHUNK_STALL_NOTICES, CHUNK_STALL_REASONS, ChunkStallReason } from '@bike4mind/common';
import { Config } from '../utils/config';

/** The three conditions a candidate must satisfy besides the marker, per findConvergencePausedFilesByScope. */
const ELIGIBILITY = {
  deletedAt: null,
  archivedAt: null,
  vectorizedChunkCount: { $not: { $gt: 0 } },
  isChunking: { $ne: true },
} as const;

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('lake', { type: 'string', demandOption: true, describe: 'DataLake _id (not a slug)' })
    .option('fabFileId', { type: 'string', describe: 'Member to mark; omit to list candidates' })
    .option('reason', {
      type: 'string',
      default: 'rechunkPaused' satisfies ChunkStallReason,
      choices: [...CHUNK_STALL_REASONS],
      describe: 'Which arm of the switch to simulate',
    })
    .option('clear', { type: 'boolean', default: false, describe: 'Remove the marker instead of setting it' })
    .option('execute', { type: 'boolean', default: false, describe: 'Write; otherwise dry-run' })
    .strict()
    .parse();

  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));
  console.log(`stage="${stage}"`);

  // A registry lake has no document and no owned members, so it cannot host this fixture - and its
  // slug would CastError here. Say so rather than surfacing the cast.
  const lake = await DataLakeModel.findById(argv.lake).catch(() => null);
  if (!lake) {
    throw new Error(
      `No DataLake document with _id="${argv.lake}". A built-in registry lake (slug id) has no ` +
        `document and no owned members - use a DB-backed lake for this fixture.`
    );
  }
  const scope = dataLakeService.lakeMembershipScope(lake);
  console.log(`lake="${lake.name}" (${lake.id}) tag=${lake.datalakeTag}`);

  const before = await fabFileRepository.findConvergencePausedFilesByScope(scope);
  console.log(`detection before: ${before.length} file(s) offered for rebuild`);

  if (!argv.fabFileId) {
    const candidates = await FabFile.find(
      buildDataLakeMembershipQuery(scope, { ...ELIGIBILITY }),
      'fileName chunkCount vectorizedChunkCount chunkStallReason'
    ).limit(50);
    if (candidates.length === 0) {
      console.log('\nNo eligible members. A candidate needs chunks, no vectors, and not be mid-chunking.');
      process.exit(1);
    }
    console.log(`\n${candidates.length} eligible member(s) - pass one as --fabFileId:`);
    for (const f of candidates) {
      console.log(`  ${f.id}  ${f.fileName}  chunks=${f.chunkCount ?? 0}  ` + `stall=${f.chunkStallReason ?? '-'}`);
    }
    process.exit(0);
  }

  // Membership is checked through the same predicate the door uses, so "eligible here" and "selected
  // there" cannot disagree - a file that is a member but ineligible reports WHICH condition failed.
  const target = await FabFile.findOne(buildDataLakeMembershipQuery(scope, { _id: argv.fabFileId }));
  if (!target) throw new Error(`fabFile ${argv.fabFileId} is not a member of this lake`);

  const blockers = [
    target.deletedAt && 'deletedAt is set',
    target.archivedAt && 'archivedAt is set',
    (target.vectorizedChunkCount ?? 0) > 0 && `vectorizedChunkCount=${target.vectorizedChunkCount} (must be 0)`,
    target.isChunking && 'isChunking=true (a worker holds it)',
  ].filter(Boolean);
  if (!argv.clear && blockers.length > 0) {
    throw new Error(
      `fabFile ${argv.fabFileId} cannot be stranded: ${blockers.join('; ')}. ` +
        `The marker alone is not enough - detection requires all of these too.`
    );
  }

  const reason = argv.reason as ChunkStallReason;
  const update = argv.clear
    ? { $unset: { chunkStallReason: '', notes: '' } }
    : { $set: { chunkStallReason: reason, notes: CHUNK_STALL_NOTICES[reason] } };

  console.log(`\n${argv.clear ? 'CLEAR' : 'SEED'} ${target.fileName} (${target.id})`);
  console.log(JSON.stringify(update, null, 2));

  if (!argv.execute) {
    console.log('\nDry run. Re-run with --execute to write.');
    process.exit(0);
  }

  await FabFile.updateOne({ _id: target._id }, update);

  const after = await fabFileRepository.findConvergencePausedFilesByScope(scope);
  console.log(`\ndetection after: ${after.length} file(s) offered for rebuild`);
  const listed = after.some(f => f.id === target.id);
  if (argv.clear ? listed : !listed) {
    console.error(
      `\nFAILED: the write landed but detection ${listed ? 'still lists' : 'does not list'} this file. ` +
        `Most likely the deployed build reads a marker field this script does not set.`
    );
    process.exit(1);
  }
  console.log(
    argv.clear
      ? 'Cleared. The rebuild door no longer offers this file.'
      : 'Seeded. GET /api/data-lakes/<lakeId>/rechunk should now report it, and Rebuild passages should render.'
  );
  process.exit(0);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
