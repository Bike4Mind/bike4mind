import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentVersion, currentVersionBasis } from './appVersion';

const app = vi.hoisted(() => ({ isPackaged: true, getVersion: () => '0.1.16' }));
vi.mock('electron', () => ({ app }));

const DEV = '0.203.0-dev.gabc123def456.dirty';
const BASIS = 'newest local tag desktop-v0.203.0 (2026-11-13); run git fetch origin --tags if that looks old';

afterEach(() => vi.unstubAllGlobals());

function bake(version: string, basis: string): void {
  vi.stubGlobal('__B4M_DEV_VERSION__', version);
  vi.stubGlobal('__B4M_DEV_VERSION_BASIS__', basis);
}

describe('currentVersion', () => {
  it('reports the app version for a packaged build, whatever was baked in', () => {
    app.isPackaged = true;
    bake(DEV, BASIS);
    expect(currentVersion()).toBe('0.1.16');
    expect(currentVersionBasis()).toBeUndefined();
  });

  it('reports the baked dev version for an unpackaged run', () => {
    app.isPackaged = false;
    bake(DEV, BASIS);
    expect(currentVersion()).toBe(DEV);
    expect(currentVersionBasis()).toBe(BASIS);
  });

  it('falls back to the app version when nothing was baked in', () => {
    app.isPackaged = false;
    bake('', '');
    expect(currentVersion()).toBe('0.1.16');
    expect(currentVersionBasis()).toBeUndefined();
  });

  it('has no basis to show when only the version was baked in', () => {
    app.isPackaged = false;
    bake(DEV, '');
    expect(currentVersionBasis()).toBeUndefined();
  });
});

describe('main-process version readers', () => {
  it('only appVersion.ts calls app.getVersion()', () => {
    const files = readdirSync(__dirname, { recursive: true, encoding: 'utf8' }).filter(
      file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)
    );
    expect(files).toContain('index.ts');
    const offenders = files.filter(
      file => file !== 'appVersion.ts' && /\bapp\.getVersion\s*\(/.test(readFileSync(join(__dirname, file), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
