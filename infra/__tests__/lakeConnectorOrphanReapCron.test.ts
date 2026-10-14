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

describe('lakeConnectorOrphanReap cron', () => {
  const cron = cut(CRON, "const lakeConnectorOrphanReapCron = new sst.aws.Cron('lakeConnectorOrphanReap'", '\n});');

  it('runs the workers reap handler daily in the VPC', () => {
    expect(cron).toMatch(/schedule:\s*'rate\(1 day\)'/);
    expect(cron).toMatch(/handler:\s*'apps\/workers\/src\/cron\/lakeConnectorOrphanReap\.handler'/);
    expect(cron).toMatch(/vpc:\s*lambdaVpc/);
    expect(cron).toMatch(/timeout:\s*'5 minutes'/);
    expect(cron).toMatch(/enabled:\s*\['production',\s*'dev'\]\.includes\(\$app\.stage\)/);
  });

  it('links the revoke queue a GitHub release defers a failed uninstall to, alongside the secrets', () => {
    expect(cron).toMatch(/link:\s*\[\.\.\.allSecrets,\s*githubLakeRevokeQueue\]/);
    expect(CRON).toMatch(/^\s+githubLakeRevokeQueue,\n[\s\S]*?\} from '\.\/queues';/m);
  });

  it('is exported with the other crons', () => {
    expect(CRON).toMatch(/^\s+lakeConnectorOrphanReapCron,$/m);
  });
});
