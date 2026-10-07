/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRON = readFileSync(path.join(REPO_ROOT, 'infra/cron.ts'), 'utf8');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

describe('githubLakeReconcile cron', () => {
  const cron = cut(CRON, "const githubLakeReconcileCron = new sst.aws.Cron('githubLakeReconcile'", '\n});');

  it('runs the workers reconcile handler every 15 minutes in the VPC', () => {
    expect(cron).toMatch(/schedule:\s*'rate\(15 minutes\)'/);
    expect(cron).toMatch(/handler:\s*'apps\/workers\/src\/cron\/githubLakeReconcile\.handler'/);
    expect(cron).toMatch(/vpc:\s*lambdaVpc/);
    expect(cron).toMatch(/enabled:\s*\['production',\s*'dev'\]\.includes\(\$app\.stage\)/);
  });

  it('links the ingest queue it enqueues onto, alongside the secrets', () => {
    expect(cron).toMatch(/link:\s*\[\.\.\.allSecrets,\s*githubLakeIngestQueue\]/);
    expect(CRON).toMatch(/^\s+githubLakeIngestQueue,\n[\s\S]*?\} from '\.\/queues';/m);
  });

  it('is exported with the other crons', () => {
    expect(CRON).toMatch(/^\s+githubLakeReconcileCron,$/m);
  });
});
