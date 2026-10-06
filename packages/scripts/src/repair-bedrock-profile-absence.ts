#!/usr/bin/env tsx

/**
 * One-off repair for Bedrock inference-profile ids the absence protocol
 * graduated to `deprecated` before discovery learned to sight a profile through
 * its foundation id. Selector and idempotency notes: ./repairBedrockProfileAbsence.ts.
 *
 * Dry run by default; pass --apply to write. The code fix must be deployed
 * first, or the next discovery run re-graduates the ids.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts repair:bedrock-profile-absence
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts repair:bedrock-profile-absence --apply
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { repairBedrockProfileAbsence } from './repairBedrockProfileAbsence';

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  await repairBedrockProfileAbsence({ apply });
  if (!apply) console.log('Dry run only. Re-run with --apply to restore the affected models.');
  process.exit(0);
}

main().catch(error => {
  console.error('[repair-bedrock-profile-absence] failed:', error);
  process.exit(1);
});
