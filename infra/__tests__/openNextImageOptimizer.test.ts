/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import openNextConfig from '../../apps/client/open-next.config';

const readJson = (rel: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', rel), 'utf8'));
const clientPkg = readJson('apps/client/package.json');
const rootPkg = readJson('package.json');

const install = openNextConfig.imageOptimization.install;
const sharpSpec = install.packages.find(p => p.startsWith('sharp@'));
const sharpVersion = sharpSpec?.slice('sharp@'.length) ?? '';

const parse = (v: string) =>
  v
    .replace(/^[\^~]/, '')
    .split('.')
    .map(Number);
const compare = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

describe('OpenNext image optimizer sharp install', () => {
  // npm selects sharp's native @img/sharp-<os>-<cpu> package by --cpu, not --arch; without it an
  // x64 deploy runner ships an x64 binary to the arm64 image Lambda and every transform fails.
  it('installs the linux arm64 glibc binary', () => {
    expect(install.additionalArgs.split(/\s+/)).toContain('--cpu=arm64');
    expect(install.arch).toBe('arm64');
    expect(install.os).toBe('linux');
    expect(install.libc).toBe('glibc');
  });

  it('pins an exact sharp version within apps/client range', () => {
    expect(sharpVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const range: string = clientPkg.dependencies.sharp;
    expect(range.startsWith('^0.')).toBe(true);
    expect(parse(sharpVersion).slice(0, 2)).toEqual(parse(range).slice(0, 2));
    expect(compare(sharpVersion, range)).toBeGreaterThanOrEqual(0);
  });

  it('stays at or above the root pnpm override floor for sharp', () => {
    const floorKey = Object.keys(rootPkg.pnpm.overrides).find(k => k.startsWith('sharp@<'));
    if (!floorKey) return;
    expect(compare(sharpVersion, floorKey.slice('sharp@<'.length))).toBeGreaterThanOrEqual(0);
  });
});
