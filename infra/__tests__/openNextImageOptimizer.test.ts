/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import openNextConfig from '../../apps/client/open-next.config';

const readRepoFile = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const rootPkg = JSON.parse(readRepoFile('package.json'));

// The `sharp` entry of the apps/client importer block in pnpm-lock.yaml, i.e. what the app actually resolves.
const resolvedClientSharp = () => {
  const lock = readRepoFile('pnpm-lock.yaml');
  const start = lock.indexOf('\n  apps/client:\n');
  if (start < 0) return undefined;
  const next = lock.slice(start + 1).search(/\n {2}\S/);
  const block = next < 0 ? lock.slice(start) : lock.slice(start, start + 1 + next);
  return block.match(/\n {6}sharp:\n {8}specifier: .+\n {8}version: (\d+\.\d+\.\d+)(?=\(|\n)/)?.[1];
};

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
  it('installs the linux arm64 glibc binary', () => {
    expect(install.additionalArgs.split(/\s+/)).toContain('--cpu=arm64');
    expect(install.arch).toBe('arm64');
    expect(install.os).toBe('linux');
    expect(install.libc).toBe('glibc');
  });

  it('pins the sharp version apps/client resolves in pnpm-lock.yaml', () => {
    expect(sharpVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolvedClientSharp()).toBe(sharpVersion);
  });

  it('stays at or above the root pnpm override floor for sharp', () => {
    const floorKey = Object.keys(rootPkg.pnpm?.overrides ?? {}).find(k => k.startsWith('sharp@<'));
    expect(floorKey).toBeDefined();
    expect(compare(sharpVersion, (floorKey ?? '').slice('sharp@<'.length))).toBeGreaterThanOrEqual(0);
  });
});
