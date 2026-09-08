#!/usr/bin/env tsx
/**
 * Score captured embedding fixtures at several Matryoshka widths and print the comparison.
 *
 * Pure: no database, no provider key, no network. Everything it needs was already paid for by
 * `capture-embeddings.ts`, so this can be re-run freely - at a new width, or after a metrics change -
 * without embedding anything twice.
 *
 *   pnpm --filter @bike4mind/scripts retrieval:model-comparison \
 *     --fixtures out/ada-002.fixture.json,out/3-small.fixture.json \
 *     --widths 3072,1536,512
 *
 * See MODEL-COMPARISON.md for the full runbook and how to read the output.
 */

import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { compareFromRaw, formatComparison } from './modelComparison';

const argv = await yargs(hideBin(process.argv))
  .option('fixtures', {
    type: 'string',
    demandOption: true,
    describe: 'Comma-separated capture fixture paths (one per model arm)',
  })
  .option('widths', {
    type: 'string',
    default: '3072,1536,512',
    describe: 'Comma-separated Matryoshka widths; any wider than a capture is skipped',
  })
  .strict()
  .parse();

const paths = argv.fixtures
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
const widths = argv.widths
  .split(',')
  .map(w => Number(w.trim()))
  .filter(w => Number.isInteger(w) && w > 0);

if (paths.length === 0) throw new Error('--fixtures matched no paths.');
if (widths.length === 0) throw new Error(`--widths "${argv.widths}" parsed to no positive integers.`);

const raws = paths.map(p => JSON.parse(readFileSync(p, 'utf8')) as unknown);
console.log(formatComparison(compareFromRaw(raws, widths)));
