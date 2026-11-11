import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = path.resolve(__dirname, '../../..');
const WORKERS_SRC = path.resolve(CLIENT_ROOT, '../workers/src');
const SERVER_UTILS_SRC = path.resolve(CLIENT_ROOT, '../../packages/server-utils/src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('USD_CHECKOUT_SESSION_PARAMS coverage', () => {
  it('is spread into every Checkout Session the app creates', () => {
    const creators = [CLIENT_ROOT + '/pages', CLIENT_ROOT + '/server', SERVER_UTILS_SRC, WORKERS_SRC]
      .flatMap(sourceFiles)
      .filter(file => readFileSync(file, 'utf8').includes('checkout.sessions.create('));

    expect(creators.length).toBeGreaterThan(0);
    const missing = creators
      .filter(file => !readFileSync(file, 'utf8').includes('...USD_CHECKOUT_SESSION_PARAMS'))
      .map(file => path.relative(CLIENT_ROOT, file));
    expect(missing).toEqual([]);
  });
});
