import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelViewState } from '@shared/model3d';
import { ModelLiveView, type ModelCaptureRequest } from './ModelLiveView';

const SOURCE = `export const params = { width: { value: 60, min: 20, max: 200, step: 1 } };
export default function model({ m, p }) { return m.Manifold.cube([p.width, 10, 10]); }
`;

describe('ModelLiveView', () => {
  let dir: string;
  let file: string;
  let states: ModelViewState[];
  let captureRequests: ModelCaptureRequest[];
  let canCapture: boolean;
  let view: ModelLiveView;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'model-view-'));
    file = join(dir, 'chest.model.js');
    writeFileSync(file, SOURCE);
    states = [];
    captureRequests = [];
    canCapture = true;
    view = new ModelLiveView(
      {
        state: state => states.push(state),
        captureRequest: request => {
          captureRequests.push(request);
          return canCapture;
        },
      },
      { debounceMs: 20, buildTimeoutMs: 200, captureTimeoutMs: 100 }
    );
  });

  afterEach(async () => {
    view.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('broadcasts the source on open and refuses unsupported files', async () => {
    const state = await view.open(file);
    expect(state).toMatchObject({ path: file, kind: 'model', source: SOURCE, missing: false, generation: 1 });
    expect(states).toHaveLength(1);
    await expect(view.open(join(dir, 'notes.txt'))).rejects.toThrow(/Not a model file/);
  });

  it('bumps the generation when the file changes on disk', async () => {
    await view.open(file);
    writeFileSync(file, SOURCE.replace('60', '70'));
    await vi.waitFor(() => expect(view.current().generation).toBe(2), { timeout: 2000 });
    expect(view.current().source).toContain('value: 70');
  });

  it('waitForBuild resolves on the matching report and ignores stale ones', async () => {
    await view.open(file);
    const pending = view.waitForBuild();
    await Promise.resolve();
    view.reportBuild({ generation: 0, ok: true });
    view.reportBuild({ generation: 1, ok: false, error: 'boom' });
    await expect(pending).resolves.toMatchObject({ generation: 1, error: 'boom' });
  });

  it('waitForBuild sees an edit made just before it, without waiting for the watcher', async () => {
    await view.open(file);
    view.reportBuild({ generation: 1, ok: true });
    writeFileSync(file, SOURCE.replace('60', '80'));
    const pending = view.waitForBuild();
    await vi.waitFor(() => expect(view.current().generation).toBe(2));
    view.reportBuild({ generation: 2, ok: true });
    await expect(pending).resolves.toMatchObject({ generation: 2 });
  });

  type ReadResult = { source: string | null; missing: boolean };

  function holdNextRead(): (result: ReadResult) => void {
    let release: (result: ReadResult) => void = () => undefined;
    const held = new Promise<ReadResult>(resolve => {
      release = resolve;
    });
    vi.spyOn(view as unknown as { read: () => Promise<ReadResult> }, 'read').mockImplementationOnce(() => held);
    return release;
  }

  it('drops a refresh that finishes after another file was opened', async () => {
    await view.open(file);
    const other = join(dir, 'other.model.js');
    writeFileSync(other, SOURCE.replace('60', '99'));
    const release = holdNextRead();
    const refreshing = view.refresh();
    await view.open(other);
    release({ source: 'stale', missing: false });
    await refreshing;
    expect(view.current()).toMatchObject({ path: other, source: SOURCE.replace('60', '99') });
  });

  it('drops a refresh that finishes after a newer one', async () => {
    await view.open(file);
    const releaseOld = holdNextRead();
    const older = view.refresh();
    const releaseNew = holdNextRead();
    const newer = view.refresh();
    releaseNew({ source: 'newer', missing: false });
    await newer;
    releaseOld({ source: 'older', missing: false });
    await older;
    expect(view.current().source).toBe('newer');
  });

  it('waitForBuild times out when no window builds', async () => {
    await view.open(file);
    await expect(view.waitForBuild()).rejects.toThrow(/did not finish building/);
  });

  it('reports a deleted file as missing', async () => {
    await view.open(file);
    await unlink(file);
    await expect(view.waitForBuild()).rejects.toThrow(/no longer exists/);
    expect(view.current().missing).toBe(true);
  });

  it('writes only the sibling GLB, and drops stale generations', async () => {
    await view.open(file);
    expect(await view.writeGlb(0, new Uint8Array([1]))).toBeNull();
    const target = await view.writeGlb(1, new Uint8Array([103, 108, 84, 70]));
    expect(target).toBe(join(dir, 'chest.glb'));
    expect(readFileSync(join(dir, 'chest.glb')).toString()).toBe('glTF');
    expect(view.glbPath()).toBe(target);
  });

  it('never writes over an opened .glb', async () => {
    const asset = join(dir, 'asset.glb');
    writeFileSync(asset, 'original');
    await view.open(asset);
    expect(await view.writeGlb(view.current().generation, new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readFileSync(asset, 'utf8')).toBe('original');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes a slider value back, and leaves the file alone when the key is unknown', async () => {
    await view.open(file);
    expect(await view.setParam('width', 90)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('value: 90');
    const before = readFileSync(file, 'utf8');
    expect(await view.setParam('height', 5)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('resolves a capture with the bytes a window returns', async () => {
    await view.open(file);
    const pending = view.capture(['front', 'iso']);
    expect(captureRequests[0].views).toEqual(['front', 'iso']);
    view.resolveCapture(captureRequests[0].id, { bytes: new Uint8Array([1, 2]) });
    await expect(pending).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it('fails a capture with no window, and on timeout', async () => {
    await view.open(file);
    canCapture = false;
    await expect(view.capture(['front'])).rejects.toThrow(/No Bike4Mind window/);
    canCapture = true;
    await expect(view.capture(['front'])).rejects.toThrow(/in time/);
  });
});
