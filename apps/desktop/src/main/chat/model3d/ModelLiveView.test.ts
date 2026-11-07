import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelViewState } from '@shared/model3d';
import { realpathNearest } from '../tools/paths';
import { withPathLock } from '../tools/writeTools';
import { isModelPaneGlb } from './glbMarker';

const fsControl = vi.hoisted(() => ({
  failMove: false,
  linkError: null as string | null,
  beforeLink: null as ((to: string) => void) | null,
  afterLstat: null as ((path: string) => void) | null,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fail = (code: string) => Promise.reject(Object.assign(new Error(`${code}: mocked`), { code }));
  return {
    ...actual,
    rename: (from: string, to: string) => (fsControl.failMove ? fail('EXDEV') : actual.rename(from, to)),
    lstat: async (path: string) => {
      const info = await actual.lstat(path);
      fsControl.afterLstat?.(path);
      return info;
    },
    link: (from: string, to: string) => {
      fsControl.beforeLink?.(to);
      return fsControl.linkError ? fail(fsControl.linkError) : actual.link(from, to);
    },
  };
});
import { ModelLiveView, type ModelCaptureRequest } from './ModelLiveView';

const SOURCE = `export const params = { width: { value: 60, min: 20, max: 200, step: 1 } };
export default function model({ m, p }) { return m.Manifold.cube([p.width, 10, 10]); }
`;

const WINDOW = 7;

/** A minimal GLB whose JSON names `generator`, so tests can tell two writes apart. */
function glb(generator: string, extras?: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0', generator, extras } }).padEnd(64));
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

const generatorOf = (path: string) =>
  (readFileSync(path)
    .toString()
    .match(/"generator":"([^"]*)"/) ?? [])[1];

describe('ModelLiveView', () => {
  let dir: string;
  let file: string;
  let states: ModelViewState[];
  let captureRequests: ModelCaptureRequest[];
  let canCapture: boolean;
  let view: ModelLiveView;

  beforeEach(() => {
    fsControl.failMove = false;
    fsControl.linkError = null;
    fsControl.beforeLink = null;
    fsControl.afterLstat = null;
    dir = mkdtempSync(join(tmpdir(), 'model-view-'));
    file = join(dir, 'chest.model.js');
    writeFileSync(file, SOURCE);
    states = [];
    captureRequests = [];
    canCapture = true;
    view = new ModelLiveView(
      {
        state: state => states.push(state),
        captureTarget: () => (canCapture ? WINDOW : null),
        captureRequest: (target, request) => {
          captureRequests.push(request);
          return target === WINDOW;
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
    // FSEvents arms the watch asynchronously, so a write in the first few ms can go unseen; keep
    // writing the same text until it is noticed (an unchanged re-read never bumps the generation).
    await vi.waitFor(
      () => {
        writeFileSync(file, SOURCE.replace('60', '70'));
        expect(view.current().generation).toBe(2);
      },
      { timeout: 2000, interval: 100 }
    );
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

  it('makes a superseded refresh wait for the newer read', async () => {
    await view.open(file);
    const releaseOld = holdNextRead();
    const older = view.refresh();
    const releaseNew = holdNextRead();
    void view.refresh();
    let settled = false;
    void older.then(() => {
      settled = true;
    });
    releaseOld({ source: 'older', missing: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    releaseNew({ source: 'newer', missing: false });
    await older;
    expect(view.current().source).toBe('newer');
  });

  it('rejects a pending build wait on dispose and leaves no timer', async () => {
    await view.open(file);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = view.waitForBuild();
      const outcome = expect(pending).rejects.toThrow('The model view closed.');
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 5 });
      view.dispose();
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    expect(await view.writeGlb(0, glb('stale'))).toBeNull();
    const target = await view.writeGlb(1, glb('current'));
    expect(target).toBe(join(dir, 'chest.glb'));
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('current');
    expect(isModelPaneGlb(readFileSync(join(dir, 'chest.glb')))).toBe(true);
    expect(view.glbPath()).toBe(target);
  });

  it('refuses to replace a sibling GLB the model pane did not write', async () => {
    const existing = join(dir, 'chest.glb');
    writeFileSync(existing, glb('Blender'));
    await view.open(file);
    await expect(view.writeGlb(1, glb('model'))).rejects.toThrow(
      /chest\.glb already exists and was not made by the model pane/
    );
    expect(generatorOf(existing)).toBe('Blender');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(view.glbPath()).toBeNull();
  });

  it('replaces a sibling GLB that an earlier build wrote', async () => {
    writeFileSync(join(dir, 'chest.glb'), glb('earlier', { bike4mindModel: true }));
    await view.open(file);
    expect(await view.writeGlb(1, glb('later'))).toBe(join(dir, 'chest.glb'));
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('later');
  });

  it('does not replace a GLB saved to the sibling path while the build was writing', async () => {
    await view.open(file);
    fsControl.beforeLink = to => writeFileSync(to, glb('saved meanwhile'));
    await expect(view.writeGlb(1, glb('model'))).rejects.toThrow(/already exists and was not made/);
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('saved meanwhile');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a sibling that is a directory or a link, even to a marked GLB', async () => {
    const marked = join(dir, 'elsewhere.glb');
    writeFileSync(marked, glb('earlier', { bike4mindModel: true }));
    symlinkSync(marked, join(dir, 'chest.glb'));
    await view.open(file);
    await expect(view.writeGlb(1, glb('model'))).rejects.toThrow(/already exists/);
    expect(generatorOf(marked)).toBe('earlier');
    const other = join(dir, 'lamp.model.js');
    writeFileSync(other, SOURCE);
    mkdirSync(join(dir, 'lamp.glb'));
    await view.open(other);
    await expect(view.writeGlb(view.current().generation, glb('model'))).rejects.toThrow(/already exists/);
  });

  it('treats a sibling deleted during the ownership check as absent', async () => {
    const sibling = join(dir, 'chest.glb');
    writeFileSync(sibling, glb('earlier', { bike4mindModel: true }));
    await view.open(file);
    fsControl.afterLstat = path => {
      fsControl.afterLstat = null;
      unlinkSync(path);
    };
    expect(await view.writeGlb(1, glb('model'))).toBe(sibling);
    expect(generatorOf(sibling)).toBe('model');
  });

  it('removes its temporary file when the GLB cannot be moved into place', async () => {
    writeFileSync(join(dir, 'chest.glb'), glb('earlier', { bike4mindModel: true }));
    await view.open(file);
    fsControl.failMove = true;
    await expect(view.writeGlb(1, glb('model'))).rejects.toThrow(/EXDEV/);
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('earlier');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(view.glbPath()).toBeNull();
  });

  it('still writes a new GLB on a disk that cannot hard-link', async () => {
    await view.open(file);
    fsControl.linkError = 'EPERM';
    expect(await view.writeGlb(1, glb('model'))).toBe(join(dir, 'chest.glb'));
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('model');
    expect(isModelPaneGlb(readFileSync(join(dir, 'chest.glb')))).toBe(true);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not replace a GLB saved meanwhile on a disk that cannot hard-link', async () => {
    await view.open(file);
    fsControl.linkError = 'ENOTSUP';
    fsControl.beforeLink = to => writeFileSync(to, glb('saved meanwhile'));
    await expect(view.writeGlb(1, glb('model'))).rejects.toThrow(/already exists and was not made/);
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('saved meanwhile');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
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

  it('serializes a slider write behind a held lock on the same file', async () => {
    await view.open(file);
    let release!: () => void;
    const held = withPathLock(await realpathNearest(file), () => new Promise<void>(resolve => (release = resolve)));
    const pending = view.setParam('width', 91);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(readFileSync(file, 'utf8')).toContain('value: 60');
    release();
    await held;
    expect(await pending).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('value: 91');
  });

  it('writes the GLB once per generation however many windows build it', async () => {
    await view.open(file);
    const [first, second] = await Promise.all([
      view.writeGlb(1, glb('first window')),
      view.writeGlb(1, glb('second window')),
    ]);
    expect(first).toBe(join(dir, 'chest.glb'));
    expect(second).toBe(first);
    expect(generatorOf(join(dir, 'chest.glb'))).toBe('first window');
  });

  it('captures only after the target window has built the current generation', async () => {
    await view.open(file);
    const pending = view.capture(['front']);
    view.reportBuild({ generation: 1, ok: true }, WINDOW + 1);
    await Promise.resolve();
    expect(captureRequests).toHaveLength(0);
    view.reportBuild({ generation: 1, ok: true }, WINDOW);
    await vi.waitFor(() => expect(captureRequests).toHaveLength(1));
    view.resolveCapture(captureRequests[0].id, { bytes: new Uint8Array([1]) });
    await expect(pending).resolves.toEqual(new Uint8Array([1]));
  });

  it('resolves a capture with the bytes a window returns', async () => {
    await view.open(file);
    view.reportBuild({ generation: 1, ok: true }, WINDOW);
    const pending = view.capture(['front', 'iso']);
    await vi.waitFor(() => expect(captureRequests).toHaveLength(1));
    expect(captureRequests[0].views).toEqual(['front', 'iso']);
    view.resolveCapture(captureRequests[0].id, { bytes: new Uint8Array([1, 2]) });
    await expect(pending).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it('fails a capture with no window, and on timeout', async () => {
    await view.open(file);
    view.reportBuild({ generation: 1, ok: true }, WINDOW);
    canCapture = false;
    await expect(view.capture(['front'])).rejects.toThrow(/No Bike4Mind window/);
    canCapture = true;
    await expect(view.capture(['front'])).rejects.toThrow(/in time/);
  });
});
