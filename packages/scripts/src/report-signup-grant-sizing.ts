#!/usr/bin/env tsx

/**
 * Read-only sizing of the existing-account signup grant migration (migrate-signup-grant-schedule.ts).
 * Prints aggregate counts only, never ids, emails or connection details, and writes nothing. Run it
 * before the migration and again after. Details: ./signupGrantSizingReport.ts.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts report:signup-grant-sizing
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { buildSignupGrantSizingReport, formatSizingReport } from './signupGrantSizingReport';

async function main() {
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log('Mode: READ ONLY (no writes)');
  const report = await buildSignupGrantSizingReport();
  for (const line of formatSizingReport(report)) console.log(line);
  process.exit(0);
}

main().catch(error => {
  console.error('[report-signup-grant-sizing] failed:', error);
  process.exit(1);
});
