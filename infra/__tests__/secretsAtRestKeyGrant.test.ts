/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('secrets-at-rest Decrypt grant', () => {
  it('is added to every Function by the global transform', () => {
    const config = read('sst.config.ts');
    const start = config.indexOf('$transform(sst.aws.Function');
    // The transform body ends at the first closing `});` at its own indentation.
    const transform = config.slice(start, config.indexOf('\n    });', start));
    expect(transform).toContain('secretsAtRestDecryptPermission(');
    expect(transform).toMatch(/args\.permissions\s*=/);
  });

  it('tags every role with the stage through a global role transform', () => {
    const config = read('sst.config.ts');
    const start = config.indexOf('$transform(aws.iam.Role');
    const transform = config.slice(start, config.indexOf('\n      });', start));
    expect(transform).toContain('secretsAtRestRoleTags(');
    expect(transform).toContain('args.tags');
  });

  it('reaches every ECS service that holds SECRET_ENCRYPTION_KEY', () => {
    const holders = ['infra/chatCompletion.ts', 'infra/renderWorker.ts', 'infra/searxng.ts'].filter(file =>
      read(file).includes("'SECRET_ENCRYPTION_KEY'")
    );
    expect(holders).toEqual(['infra/chatCompletion.ts']);
    expect(read('infra/chatCompletion.ts')).toContain('secretsAtRestDecryptPermission(secretsAtRestKey.arn');
  });

  it('declares the wrapped blob secret and moves it to ChatCompletion task secrets', () => {
    expect(read('infra/secrets.ts')).toContain("new sst.Secret('SECRET_ENCRYPTION_KEY_WRAPPED', 'not-configured')");
    expect(read('infra/chatCompletion.ts')).toContain("'SECRET_ENCRYPTION_KEY_WRAPPED'");
  });
});
