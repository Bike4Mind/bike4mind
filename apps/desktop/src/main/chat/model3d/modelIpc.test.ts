import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }));

const { writeExport, parseBuildReport } = await import('./modelIpc');
const { isModelPaneGlb } = await import('./glbMarker');

function glb(): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }).padEnd(32));
  const out = new Uint8Array(20 + json.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out;
}

describe('writeExport', () => {
  function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'model-export-')));
    return { root, model: join(root, 'chest.model.js') };
  }
  const marked = (path: string) => isModelPaneGlb(new Uint8Array(readFileSync(path)));

  it('marks a GLB exported onto the sibling path, so the next build may replace it', async () => {
    const { root, model } = project();
    await writeExport('glb', glb(), join(root, 'chest.glb'), model);
    expect(marked(join(root, 'chest.glb'))).toBe(true);
  });

  it('marks the sibling reached through another spelling of its folder', async () => {
    const { root, model } = project();
    const alias = join(realpathSync(mkdtempSync(join(tmpdir(), 'model-alias-'))), 'proj');
    symlinkSync(root, alias);
    await writeExport('glb', glb(), join(alias, 'chest.glb'), model);
    expect(marked(join(root, 'chest.glb'))).toBe(true);
    writeFileSync(join(root, 'chest.glb'), glb());
    await writeExport('glb', glb(), join(alias, 'chest.glb'), model);
    expect(marked(join(root, 'chest.glb'))).toBe(true);
  });

  it('leaves a GLB exported anywhere else, and every STL, as the user asset it is', async () => {
    const { root, model } = project();
    mkdirSync(join(root, 'export'));
    await writeExport('glb', glb(), join(root, 'export', 'chest.glb'), model);
    expect(marked(join(root, 'export', 'chest.glb'))).toBe(false);
    await writeExport('glb', glb(), join(root, 'chest.glb'), null);
    expect(marked(join(root, 'chest.glb'))).toBe(false);
    await writeExport('stl', glb(), join(root, 'chest.glb'), model);
    expect(marked(join(root, 'chest.glb'))).toBe(false);
  });
});

describe('parseBuildReport', () => {
  const summary = { parts: ['body', 'lid'], size: [60, 40, 40], units: 'mm', triangles: 24, params: { width: 60 } };

  it('keeps the joints the renderer reported', () => {
    const report = parseBuildReport({
      generation: 3,
      ok: true,
      summary: { ...summary, joints: ['lid: pivot (0, 40, 30), in body', 7] },
    });
    expect(report?.summary?.joints).toEqual(['lid: pivot (0, 40, 30), in body']);
  });

  it('leaves joints out when no part has a pivot', () => {
    const report = parseBuildReport({ generation: 3, ok: true, summary });
    expect(report?.summary).not.toHaveProperty('joints');
  });

  it('keeps why the GLB was not written, and only as text', () => {
    expect(parseBuildReport({ generation: 3, ok: true, summary, glbError: 'EROFS' })?.glbError).toBe('EROFS');
    expect(parseBuildReport({ generation: 3, ok: true, summary, glbError: 42 })).not.toHaveProperty('glbError');
  });

  it('drops a report without a generation', () => {
    expect(parseBuildReport({ ok: true })).toBeNull();
  });
});
