/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WRAPPED_DATA_KEY_SECRET_NAME } from '../../b4m-core/common/src/secretsAtRest';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

/** The text from `opener` (at `from`, default its first occurrence) to its matching closing brace. */
function guardedBlock(source: string, opener: string, from = source.indexOf(opener)): string {
  expect(from).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = from + opener.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1);
  }
  throw new Error(`unclosed block after ${opener}`);
}

describe('secrets-at-rest Decrypt grant', () => {
  it('is added to every Function by the global transform', () => {
    const config = read('sst.config.ts');
    const start = config.indexOf('$transform(sst.aws.Function');
    // The transform body ends at the first closing `});` at its own indentation.
    const transform = config.slice(start, config.indexOf('\n    });', start));
    expect(transform).toContain('secretsAtRestDecryptPermission(');
    expect(transform).toMatch(/args\.permissions\s*=/);
    // A keyless stage must not dereference the key: the grant sits inside the guard's braces.
    expect(guardedBlock(transform, 'if (secretsAtRestKey) {')).toContain('secretsAtRestDecryptPermission(');
  });

  it('tags every role with the stage through a global role transform', () => {
    const config = read('sst.config.ts');
    const start = config.indexOf('$transform(aws.iam.Role');
    const transform = config.slice(start, config.indexOf('\n      });', start));
    expect(transform).toContain('secretsAtRestRoleTags(');
    expect(transform).toContain('args.tags');
    // The whole transform is registered only where a key exists.
    expect(
      guardedBlock(config, 'if (secretsAtRestKey) {', config.lastIndexOf('if (secretsAtRestKey) {', start))
    ).toContain('$transform(aws.iam.Role');
  });

  it('leaves the sandbox role untagged, by the logical name the role is declared with', () => {
    const transform = read('sst.config.ts');
    const start = transform.indexOf('$transform(aws.iam.Role');
    const body = transform.slice(start, transform.indexOf('\n      });', start));
    expect(body).toContain("if (name === 'CallableFunctionRuntimeRole') return;");
    expect(body.indexOf("if (name === 'CallableFunctionRuntimeRole') return;")).toBeLessThan(body.indexOf('args.tags'));
    expect(read('infra/callableFunctionRuntime.ts')).toContain("new aws.iam.Role('CallableFunctionRuntimeRole'");
  });

  it('reaches every ECS service that holds SECRET_ENCRYPTION_KEY', () => {
    const holders = ['infra/chatCompletion.ts', 'infra/renderWorker.ts', 'infra/searxng.ts'].filter(file =>
      read(file).includes("'SECRET_ENCRYPTION_KEY'")
    );
    expect(holders).toEqual(['infra/chatCompletion.ts']);
    expect(read('infra/chatCompletion.ts')).toContain('secretsAtRestDecryptPermission(secretsAtRestKey.arn');
  });

  it('declares the wrapped blob secret and moves it to ChatCompletion task secrets', () => {
    expect(read('infra/secrets.ts')).toContain(`new sst.Secret('${WRAPPED_DATA_KEY_SECRET_NAME}', 'not-configured')`);
    expect(read('infra/chatCompletion.ts')).toContain(`'${WRAPPED_DATA_KEY_SECRET_NAME}'`);
  });

  it('is the secret the keyring reads, so a minted stage switches to the KMS key', () => {
    expect(read('packages/database/src/security/loadKeyringFromResource.ts')).toContain(
      'read(WRAPPED_DATA_KEY_SECRET_NAME)'
    );
  });
});
