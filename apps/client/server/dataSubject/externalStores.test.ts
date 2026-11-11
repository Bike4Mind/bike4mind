import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_DATA_STORES } from './externalStores';

const repoRoot = path.resolve(__dirname, '../../../..');
const infraDir = path.join(repoRoot, 'infra');

function gitGrep(pattern: string, pathspec: string): string {
  try {
    return execFileSync('git', ['grep', '-h', '-E', pattern, '--', pathspec], { cwd: repoRoot, encoding: 'utf8' });
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

const infraSources: readonly string[] = readdirSync(infraDir, { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.split(path.sep).includes('__tests__'))
  .map(file => readFileSync(path.join(infraDir, file), 'utf8'));

/** Variables bound to `new sst.aws.<constructorName>(` anywhere under `infra/`, including across a line break or behind a stage-gating ternary. */
function declaredInInfra(constructorName: string): string[] {
  const declaration = new RegExp(`const (\\w+)\\s*=\\s*(?:[^;=]*\\?\\s*)?new sst\\.aws\\.${constructorName}\\(`, 'g');
  return infraSources.flatMap(source => [...source.matchAll(declaration)].map(match => match[1])).sort();
}

/** Every construction of the resource, assigned or not, so one this test cannot name still fails it. */
function constructedInInfra(pattern: RegExp): number {
  return infraSources.reduce((count, source) => count + [...source.matchAll(pattern)].length, 0);
}

const inventoried = (kind: 's3' | 'eventBus') =>
  [
    ...new Set(
      EXTERNAL_DATA_STORES.flatMap(store => {
        if (store.kind === 's3' && kind === 's3') return [store.bucket];
        if (store.kind === 'eventBus' && kind === 'eventBus') return [store.bus];
        return [];
      })
    ),
  ].sort();

describe('external data stores', () => {
  it('sanity: finds the buckets declared in infra', () => {
    expect(declaredInInfra('Bucket')).toContain('fabFileBucket');
  });

  it('every bucket and bus in infra is a named const declaration the inventory check can see', () => {
    expect(constructedInInfra(/new (sst\.aws\.Bucket|aws\.s3\.Bucket(V2)?)\(/g)).toBe(declaredInInfra('Bucket').length);
    expect(constructedInInfra(/new (sst\.aws\.Bus|aws\.cloudwatch\.EventBus)\(/g)).toBe(declaredInInfra('Bus').length);
  });

  it('inventories exactly the S3 buckets declared in infra', () => {
    expect(inventoried('s3')).toEqual(declaredInInfra('Bucket'));
  });

  it('inventories exactly the event buses declared in infra', () => {
    expect(inventoried('eventBus')).toEqual(declaredInInfra('Bus'));
  });

  it.each(EXTERNAL_DATA_STORES.flatMap(store => (store.erasure.action === 'erased' ? [store.erasure.erasedBy] : [])))(
    'erasedBy function %s is exported from the repo',
    functionName => {
      const pattern = `export ((async )?function|const) ${functionName}([^A-Za-z0-9_]|$)`;
      expect(gitGrep(pattern, '*.ts')).not.toBe('');
    }
  );
});
