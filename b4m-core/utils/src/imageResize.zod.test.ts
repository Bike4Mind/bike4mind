import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Jimp, type JimpInstance } from 'jimp';

// jimp 1.x declares zod ^3, which has no release patched for GHSA-mrhx-c7xc-m3w5. The
// `zod@<4.0.0` override in pnpm-workspace.yaml moves jimp's plugins onto the patched zod 4; these
// tests fail if that override is dropped or a jimp upgrade starts resolving an unpatched zod.
const PATCHED_ZOD = [4, 6, 6] as const;

type PackageJson = { name: string; version: string; dependencies?: Record<string, string> };

function readManifest(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
}

/** Directory of `name` as Node resolves it from `fromDir` (walks up from the entry file). */
function resolvePackageDir(fromDir: string, name: string): string {
  let dir = dirname(createRequire(join(fromDir, 'noop.js')).resolve(name));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && readManifest(dir).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no package.json for ${name} above its entry (resolved from ${fromDir})`);
}

function isPatchedZod(version: string): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < PATCHED_ZOD.length; i++) {
    if (parts[i] !== PATCHED_ZOD[i]) return parts[i] > PATCHED_ZOD[i];
  }
  return true;
}

/** Every @jimp/* package reachable from jimp that depends on zod, with the zod it resolves. */
function jimpZodDependents(): Array<{ dependent: string; zodVersion: string }> {
  const queue = [resolvePackageDir(dirname(fileURLToPath(import.meta.url)), 'jimp')];
  const seen = new Set<string>();
  const found: Array<{ dependent: string; zodVersion: string }> = [];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    const manifest = readManifest(dir);
    if (seen.has(manifest.name)) continue;
    seen.add(manifest.name);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep === 'zod') {
        found.push({ dependent: manifest.name, zodVersion: readManifest(resolvePackageDir(dir, 'zod')).version });
      } else if (dep.startsWith('@jimp/')) {
        queue.push(resolvePackageDir(dir, dep));
      }
    }
  }
  return found;
}

describe('jimp resolves a zod patched for GHSA-mrhx-c7xc-m3w5', () => {
  it('every @jimp/* zod dependent resolves zod >= 4.6.6', () => {
    const dependents = jimpZodDependents();

    // Guards against a vacuous pass: the plugins that validate options must actually be found.
    // If a jimp upgrade drops zod entirely, revisit the override rather than this list.
    expect(dependents.map(d => d.dependent)).toEqual(
      expect.arrayContaining(['@jimp/plugin-resize', '@jimp/plugin-crop'])
    );
    expect(dependents.filter(d => !isPatchedZod(d.zodVersion))).toEqual([]);
  });

  it('still validates plugin options through zod after the cross-major move', async () => {
    const image = new Jimp({ width: 4, height: 4, color: 0xff0000ff });

    // A wrong type and a missing required field must still be rejected by jimp's zod schemas.
    expect(() => image.clone().resize({ w: 'wide' as unknown as number })).toThrow(
      expect.objectContaining({ name: 'ZodError' })
    );
    expect(() => image.clone().crop({ x: 0, y: 0, w: 2 } as unknown as Parameters<JimpInstance['crop']>[0])).toThrow(
      expect.objectContaining({ name: 'ZodError' })
    );

    // Valid options still pass validation end to end, through an encode/decode round trip.
    const resized = image.clone().resize({ w: 2 }).crop({ x: 0, y: 0, w: 2, h: 1 });
    expect([resized.width, resized.height]).toEqual([2, 1]);
    const decoded = await Jimp.read(await resized.getBuffer('image/png'));
    expect([decoded.width, decoded.height]).toEqual([2, 1]);
  });
});
