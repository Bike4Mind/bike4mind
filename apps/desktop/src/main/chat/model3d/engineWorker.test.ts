import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { resolveEngineAsset } from './engineProtocol';

type Part = { name: string; positions: Float32Array; indices: Uint32Array };
type Reply = { ok: true; parts: Part[] } | { ok: false; error: string };

const scratch = mkdtempSync(join(tmpdir(), 'model-worker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Runs the real worker script in Node against the real manifold-3d build: the browser globals it
 * leans on (self, a blob: URL for the model source) are stood in for, nothing else.
 */
async function build(source: string, print: boolean): Promise<Reply> {
  const asset = resolveEngineAsset('/worker.js');
  if (asset?.kind !== 'inline') throw new Error('worker.js is not served inline');
  const manifold = pathToFileURL(createRequire(import.meta.url).resolve('manifold-3d/manifold.js')).href;
  const file = join(scratch, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, asset.body.replace("'./manifold.js'", JSON.stringify(manifold)));
  const modelFile = join(scratch, `model-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(modelFile, source);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue(pathToFileURL(modelFile).href);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const reply = new Promise<Reply>(resolve => {
    (globalThis as { self?: unknown }).self = { postMessage: (data: Reply) => resolve(data) };
  });
  await import(/* @vite-ignore */ pathToFileURL(file).href);
  const worker = (globalThis as { self: { onmessage: (event: { data: unknown }) => Promise<void> } }).self;
  await worker.onmessage({ data: { source, params: {}, print } });
  return reply;
}

/** True when every edge is shared by exactly two triangles, i.e. the mesh is closed. */
function isClosed({ positions, indices }: Part): boolean {
  const key = (index: number) => Array.from(positions.subarray(index * 3, index * 3 + 3)).join(',');
  const edges = new Map<string, number>();
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [indices[index], indices[index + 1], indices[index + 2]].map(key);
    for (let side = 0; side < 3; side += 1) {
      const edge = [corners[side], corners[(side + 1) % 3]].sort().join('|');
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return [...edges.values()].every(count => count === 2);
}

// Two cubes that overlap by half: as parts they are two shells, for a print one solid.
const OVERLAPPING = `export default function model({ m }) {
  const { Manifold } = m;
  return [
    { name: 'a', color: '#ff0000', shape: Manifold.cube([10, 10, 10]) },
    { name: 'b', color: '#00ff00', shape: Manifold.cube([10, 10, 10]).translate([5, 0, 0]) },
  ];
}`;

describe('model worker', () => {
  it('keeps each part separate in a normal build', async () => {
    const reply = await build(OVERLAPPING, false);
    expect(reply.ok && reply.parts.map(part => part.name)).toEqual(['a', 'b']);
  });

  it('unions every part into one closed solid for a print', async () => {
    const reply = await build(OVERLAPPING, true);
    if (!reply.ok) throw new Error(reply.error);
    expect(reply.parts).toHaveLength(1);
    const [solid] = reply.parts;
    expect(isClosed(solid)).toBe(true);
    const xs = Array.from(solid.positions.filter((_value, index) => index % 3 === 0));
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 15]);
  });

  it('reports a part that is not a shape the same way for a print', async () => {
    const reply = await build('export default function model() { return [{ name: "x" }]; }', true);
    expect(reply.ok ? '' : reply.error).toContain('item 0 is not');
  });
});
