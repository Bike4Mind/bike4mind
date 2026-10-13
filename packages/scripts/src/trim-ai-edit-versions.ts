#!/usr/bin/env tsx

/**
 * Trim AI-edited files that already hold more versions than the AiEditVersionRetention admin
 * setting allows, deleting the dropped versions' objects. Logic and safety notes:
 * ./trimAiEditVersions.ts.
 *
 * Dry run by default; pass --apply to write. --max <n> overrides the admin setting.
 *
 * Usage (inside an SST shell so the Mongo URI and bucket resolve):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts trim:ai-edit-versions
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts trim:ai-edit-versions --apply
 */

import { resolveAiEditVersionRetention } from '@bike4mind/common';
import { adminSettingsRepository, connectDB } from '@bike4mind/database';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { trimAiEditVersions } from './trimAiEditVersions';

async function main() {
  const dryRun = !process.argv.includes('--apply');
  const maxFlag = process.argv.indexOf('--max');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  const configured =
    maxFlag >= 0
      ? process.argv[maxFlag + 1]
      : (await getSettingsByNames(['AiEditVersionRetention'], { adminSettings: adminSettingsRepository }))
          .AiEditVersionRetention;
  const maxEditedVersions = resolveAiEditVersionRetention(configured);

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}; keeping v1 + last ${maxEditedVersions} edits`);
  const result = await trimAiEditVersions({
    dryRun,
    maxEditedVersions,
    storage: new S3Storage(Resource.fabFileBucket.name),
  });
  console.log(
    `files: ${result.files}, versions: ${result.versions}, bytes: ${result.bytes}, ` +
      `skipped: ${result.skipped}, delete failures: ${result.deleteFailures}`
  );
  if (dryRun) console.log('Dry run only. Re-run with --apply to trim.');
  process.exit(0);
}

main().catch(error => {
  console.error('[trim-ai-edit-versions] failed:', error);
  process.exit(1);
});
