import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the Turborepo cache tokens to the cache handler. Anything in infra/secrets.ts `secrets`
 * reaches `allSecrets`, which every app Lambda links, so the tokens are declared and linked in
 * infra/turborepoCache.ts instead.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const TOKEN_NAMES = ['TURBO_CACHE_TOKEN', 'TURBO_CACHE_READ_TOKEN'];

describe('Turborepo cache secret scope', () => {
  it('keeps the cache tokens out of the shared app secrets', () => {
    const shared = read('infra/secrets.ts');
    for (const name of TOKEN_NAMES) expect(shared).not.toContain(name);
  });

  it('declares each cache token only in the cache module', () => {
    const infraDir = path.join(REPO_ROOT, 'infra');
    const declaring = fs
      .readdirSync(infraDir)
      .filter(file => file.endsWith('.ts'))
      .filter(file => TOKEN_NAMES.some(name => read(`infra/${file}`).includes(`new sst.Secret('${name}'`)));
    expect(declaring).toEqual(['turborepoCache.ts']);
  });

  it('links the tokens into the cache handler alone and caps its concurrency', () => {
    const source = read('infra/turborepoCache.ts');
    const functionStart = source.indexOf("new sst.aws.Function('TurboCacheHandler'");
    expect(functionStart).toBeGreaterThan(-1);
    const declaration = source.slice(functionStart, source.indexOf('\n      })', functionStart));
    expect(declaration).toMatch(/link: \[turboCacheBucket, turboCacheWriteToken, turboCacheReadToken\]/);
    expect(declaration).toMatch(/concurrency: \{ reserved: \d+ \}/);
    expect(source).not.toMatch(/from '\.\/secrets'/);
  });
});
