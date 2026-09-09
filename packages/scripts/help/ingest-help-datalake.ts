#!/usr/bin/env tsx
/**
 * Bootstrap driver for the `system-help` data-lake mirror.
 *
 * The mirror itself lives in `ingestHelpDatalake.ts`, shared with the scheduled re-sync cron
 * (apps/client/server/cron/helpDatalakeIngest.ts). This script is the one-off per environment:
 * it is what CREATES the lake, and the lake's `createdByUserId` is what the cron then reuses as
 * the file owner, so `--userId` must be a system/admin account whose effective LLM keys can keep
 * embedding after this run.
 *
 * Source of truth: apps/client/app/generated/help-index.json + apps/client/public/help-content/*
 * (produced by `pnpm --filter @bike4mind/scripts help:regenerate`). Run that first if stale.
 *
 * Usage (per environment - needs DB + an embedding API key, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/help/ingest-help-datalake.ts --userId <systemUserId>
 *   npx sst shell --stage production -- tsx packages/scripts/help/ingest-help-datalake.ts --userId <systemUserId>
 *
 * --dry-run reports what would happen without writing.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  connectDB,
  fabFileRepository,
  fabFileChunkRepository,
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { createHelpEmbedder, ingestHelpDatalake } from './ingestHelpDatalake.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const HELP_INDEX_PATH = path.join(REPO_ROOT, 'apps/client/app/generated/help-index.json');
const HELP_CONTENT_ROOT = path.join(REPO_ROOT, 'apps/client/public/help-content');

async function main(opts: { userId: string; dryRun: boolean }): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage})`);

  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModel || !isSupportedEmbeddingModel(embeddingModel)) {
    throw new Error(`defaultEmbeddingModel is unset or unsupported: ${String(embeddingModel)}`);
  }
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(opts.userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  console.log(`Embedding model: ${embeddingModel}`);

  await ingestHelpDatalake(
    {
      db: {
        fabFiles: fabFileRepository,
        fabFileChunks: fabFileChunkRepository,
        dataLakes: dataLakeRepository,
      },
      embed: createHelpEmbedder(embeddingModel, apiKeyTable),
      embeddingModel,
      logger: { info: msg => console.log(msg), warn: msg => console.warn(msg) },
    },
    {
      userId: opts.userId,
      helpIndexPath: HELP_INDEX_PATH,
      helpContentRoot: HELP_CONTENT_ROOT,
      dryRun: opts.dryRun,
    }
  );
  return 0;
}

const argv = yargs(hideBin(process.argv))
  .option('userId', { type: 'string', demandOption: true, describe: 'FabFile owner + whose LLM key embeds chunks' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Report without writing' })
  .parseSync();

main({ userId: argv.userId, dryRun: argv['dry-run'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
