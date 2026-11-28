#!/usr/bin/env tsx

/**
 * Mints the wrapped stage data key and stores it as an SST secret. Idempotent: a stage that already has one is left alone.
 *
 * Usage (with credentials for the stage's account):
 *   pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] [--dry-run]
 */

import { runCli } from './createWrappedStageDataKey';

runCli(process.argv.slice(2), process.env).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
