import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }));

const { exportBytes, parseBuildReport } = await import('./modelIpc');
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

describe('exportBytes', () => {
  it('marks a GLB exported onto the sibling path, so the next build may replace it', () => {
    expect(isModelPaneGlb(exportBytes('glb', glb(), '/proj/chest.glb', '/proj/chest.model.js'))).toBe(true);
  });

  it('leaves a GLB exported anywhere else, and every STL, as the user asset it is', () => {
    const bytes = glb();
    expect(exportBytes('glb', bytes, '/proj/export/chest.glb', '/proj/chest.model.js')).toBe(bytes);
    expect(exportBytes('glb', bytes, '/proj/chest.glb', null)).toBe(bytes);
    expect(exportBytes('stl', bytes, '/proj/chest.glb', '/proj/chest.model.js')).toBe(bytes);
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
