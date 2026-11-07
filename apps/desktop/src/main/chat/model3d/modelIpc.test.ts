import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
  },
}));

const { writeFile: writeFileSpy } = await import('node:fs/promises');
const { writeExport, parseBuildReport, modelIpcHandlers } = await import('./modelIpc');
const { ModelLiveViews } = await import('./ModelLiveViews');
const { IPC_CHANNELS } = await import('@shared/ipc');
const { EMPTY_MODEL_STATE } = await import('@shared/model3d');
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

  it('writes a new sibling once, stamped, when reached through another spelling of its folder', async () => {
    const { root, model } = project();
    const alias = join(realpathSync(mkdtempSync(join(tmpdir(), 'model-alias-'))), 'proj');
    symlinkSync(root, alias);
    vi.mocked(writeFileSpy).mockClear();
    await writeExport('glb', glb(), join(alias, 'chest.glb'), model);
    expect(vi.mocked(writeFileSpy)).toHaveBeenCalledTimes(1);
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

describe('modelIpcHandlers', () => {
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: { id: 7 } }, ...args);

  it("answers each conversation with its own model, so a new chat does not show the last one's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-ipc-'));
    const file = join(dir, 'chest.model.js');
    writeFileSync(file, 'export default () => null;\n');
    const views = new ModelLiveViews({ state: () => {}, captureTarget: () => null, captureRequest: () => false });
    modelIpcHandlers(views);
    await views.for('chat-a').open(file);

    expect(await invoke(IPC_CHANNELS.modelGetState, 'chat-a')).toMatchObject({ path: file });
    expect(await invoke(IPC_CHANNELS.modelGetState, 'chat-b')).toEqual(EMPTY_MODEL_STATE);
    // A report from the new chat's pane cannot settle the first chat's build.
    const waiting = views.for('chat-a').waitForBuild();
    await invoke(IPC_CHANNELS.modelBuildReport, 'chat-b', { generation: 1, ok: false, error: 'wrong chat' });
    await invoke(IPC_CHANNELS.modelBuildReport, 'chat-a', { generation: 1, ok: true });
    await expect(waiting).resolves.toMatchObject({ ok: true });
    views.dispose();
  });

  it('refuses a request that names no conversation', async () => {
    const views = new ModelLiveViews({ state: () => {}, captureTarget: () => null, captureRequest: () => false });
    modelIpcHandlers(views);
    await expect(Promise.resolve().then(() => invoke(IPC_CHANNELS.modelGetState))).rejects.toThrow(/conversation/);
    views.dispose();
  });
});
