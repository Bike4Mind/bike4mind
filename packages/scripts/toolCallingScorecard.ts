#!/usr/bin/env tsx
/**
 * Prints the tool-calling scorecard over recent stored quests, optionally writing the JSON report.
 *
 *   MONGODB_URI=... pnpm --filter @bike4mind/scripts eval:tool-calling --days 7 --limit 5000 --json out.json
 *
 * Only reads quests, but `connectDB` seeds the model catalog like every script here does, so run it
 * from a checkout matching the target deployment. Scores turns that offered or called a tool;
 * Mongoose defaults `offeredTools` to [], so a bare $exists would admit every quest.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectDB, Quest, whenCatalogSeeded } from '@bike4mind/database';
import {
  buildToolCallingReport,
  formatToolCallingReport,
  type ToolCallingTurn,
} from '@bike4mind/services/evals/toolCalling';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: '../../.env' });

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${flag} must be a positive integer, got "${raw}"`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const days = positiveInt(values.days, DEFAULT_DAYS, 'days');
  const limit = positiveInt(values.limit, DEFAULT_LIMIT, 'limit');

  const dbUri = process.env.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI environment variable is required');
  await connectDB(dbUri.replace('%STAGE%', process.env.STAGE || 'development'));

  // Bounding on _id rides the primary index instead of scanning every quest.
  const since = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - days * MS_PER_DAY) / 1000));
  const quests = await Quest.find(
    {
      _id: { $gte: since },
      $or: [{ 'promptMeta.offeredTools.0': { $exists: true } }, { 'promptMeta.functionCalls.0': { $exists: true } }],
    },
    { 'promptMeta.offeredTools': 1, 'promptMeta.functionCalls': 1, 'promptMeta.toolMode': 1 }
  )
    .sort({ _id: -1 })
    .limit(limit)
    .lean();

  const turns: ToolCallingTurn[] = quests.map(quest => ({
    offeredTools: quest.promptMeta?.offeredTools,
    functionCalls: quest.promptMeta?.functionCalls,
    toolMode: quest.promptMeta?.toolMode,
  }));
  const report = buildToolCallingReport(turns);

  console.log(`${turns.length} turn(s) from the last ${days} day(s), newest first, capped at ${limit}`);
  console.log(formatToolCallingReport(report));
  if (values.json) {
    await writeFile(values.json, JSON.stringify(report, null, 2));
    console.log(`JSON report written to ${values.json}`);
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  // Let the fire-and-forget catalog seed settle so disconnect does not cut it off mid-write.
  .finally(async () => {
    await whenCatalogSeeded();
    await mongoose.disconnect();
  });
