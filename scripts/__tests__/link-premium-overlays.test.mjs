import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The script derives its repo root from its own location, so every case runs a copy of it
// inside a throwaway tree. realpath: macOS /var is a symlink to /private/var.
const scriptPath = fileURLToPath(new URL('../link-premium-overlays.mjs', import.meta.url));

let dir;
let clientPath;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-premium-overlays-')));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(scriptPath, path.join(dir, 'scripts', 'link-premium-overlays.mjs'));
  clientPath = path.join(dir, 'apps/client/package.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath, contents) {
  const p = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

const writeManifest = (relPath, value) => write(relPath, `${JSON.stringify(value, null, 2)}\n`);
const overlay = (relDir, value) => writeManifest(path.join('packages/premium', relDir, 'package.json'), value);
const readClient = () => JSON.parse(fs.readFileSync(clientPath, 'utf8'));

function run(env = {}) {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'link-premium-overlays.mjs')], {
    env: { ...process.env, B4M_SELF_HOST: 'true', ...env },
    encoding: 'utf8',
  });
  return { status: res.status, output: res.stdout + res.stderr };
}

describe('link-premium-overlays', () => {
  it('declares a contributing overlay as a workspace dependency, keeping existing deps', () => {
    writeManifest('apps/client/package.json', {
      name: '@bike4mind/client',
      dependencies: { react: '19.0.0' },
    });
    overlay('opti', { name: '@bike4mind/premium-opti', b4mContributions: { spaRoutesExport: 'opti/routes' } });

    const res = run();

    expect(res.status).toBe(0);
    expect(res.output).toMatch(/linked 1 overlay\(s\)/);
    expect(readClient().dependencies).toEqual({
      react: '19.0.0',
      '@bike4mind/premium-opti': 'workspace:*',
    });
    // Written with a trailing newline, as the tracked manifest is.
    expect(fs.readFileSync(clientPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('links only named packages that contribute', () => {
    writeManifest('apps/client/package.json', { name: '@bike4mind/client', dependencies: {} });
    overlay('named-no-contrib', { name: '@bike4mind/premium-named' });
    overlay('contrib-no-name', { b4mContributions: { spaRoutesExport: 'x/routes' } });
    overlay('ok', { name: '@bike4mind/premium-ok', b4mContributions: { spaRoutesExport: 'ok/routes' } });

    const res = run();

    expect(res.status).toBe(0);
    expect(readClient().dependencies).toEqual({ '@bike4mind/premium-ok': 'workspace:*' });
  });

  it('collapses duplicate names, overwrites an existing version, and sorts the output', () => {
    writeManifest('apps/client/package.json', {
      name: '@bike4mind/client',
      dependencies: { '@bike4mind/premium-b': '^1.0.0' },
    });
    overlay('one', { name: '@bike4mind/premium-b', b4mContributions: {} });
    overlay('two', { name: '@bike4mind/premium-b', b4mContributions: {} });
    overlay('three', { name: '@bike4mind/premium-a', b4mContributions: {} });

    const res = run();

    expect(res.status).toBe(0);
    expect(res.output).toMatch(/premium-a, @bike4mind\/premium-b/);
    expect(readClient().dependencies).toEqual({
      '@bike4mind/premium-b': 'workspace:*',
      '@bike4mind/premium-a': 'workspace:*',
    });
  });

  it('leaves the client manifest byte-identical when packages/premium is absent', () => {
    const original = `${JSON.stringify({ name: '@bike4mind/client', dependencies: { react: '19.0.0' } }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(clientPath, original);

    const res = run();

    expect(res.status).toBe(0);
    expect(res.output).toMatch(/nothing to link/);
    expect(fs.readFileSync(clientPath, 'utf8')).toBe(original);
  });

  it('leaves the client manifest byte-identical when packages/premium is empty', () => {
    const original = `${JSON.stringify({ name: '@bike4mind/client', dependencies: {} }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(clientPath, original);
    fs.mkdirSync(path.join(dir, 'packages/premium'), { recursive: true });

    const res = run();

    expect(res.status).toBe(0);
    expect(fs.readFileSync(clientPath, 'utf8')).toBe(original);
  });

  it('fails with the manifest path when an overlay manifest is malformed', () => {
    writeManifest('apps/client/package.json', { name: '@bike4mind/client', dependencies: {} });
    write('packages/premium/bad/package.json', '{oops');

    const res = run();

    expect(res.status).toBe(1);
    expect(res.output).toMatch(/packages\/premium\/bad\/package\.json/);
  });

  it('fails, and writes nothing, when the client manifest is missing', () => {
    overlay('ok', { name: '@bike4mind/premium-ok', b4mContributions: {} });

    const res = run();

    expect(res.status).toBe(1);
    expect(fs.existsSync(clientPath)).toBe(false);
  });

  it('refuses to rewrite the manifest outside the self-host build', () => {
    const original = `${JSON.stringify({ name: '@bike4mind/client', dependencies: {} }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(clientPath, original);
    overlay('ok', { name: '@bike4mind/premium-ok', b4mContributions: {} });

    const res = run({ B4M_SELF_HOST: '' });

    expect(res.status).toBe(1);
    expect(res.output).toMatch(/B4M_SELF_HOST/);
    expect(fs.readFileSync(clientPath, 'utf8')).toBe(original);
  });
});
