import { randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  EMPTY_MODEL_STATE,
  type ModelBuildReport,
  type ModelPose,
  type ModelView,
  type ModelViewState,
  modelKindFor,
  siblingGlbPath,
  writeParamValue,
} from '@shared/model3d';

export type ModelCaptureRequest = { id: string; views: ModelView[]; pose: ModelPose };

export type ModelLiveViewEvents = {
  state: (state: ModelViewState) => void;
  /** Ask a window to render screenshots; false when no window can. */
  captureRequest: (request: ModelCaptureRequest) => boolean;
};

export type ModelLiveViewOptions = {
  debounceMs?: number;
  buildTimeoutMs?: number;
  captureTimeoutMs?: number;
};

type Waiter = { resolve: (report: ModelBuildReport) => void };
type PendingCapture = { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * The one model the app is showing, app-wide like the simulator's live view (one pane, following
 * the last `model_view`). Main owns the file: it watches it, hands its text to the renderer, and
 * performs the only writes (the sibling GLB and slider values). The renderer owns the build, which
 * runs in the sandboxed b4m-model: engine, and reports back per generation.
 *
 * Paths come from two places: the agent's tools, confined to the session's roots (modelTools.ts),
 * and the user's own Open dialog (modelIpc.ts), which may be anywhere. A tool call that names no
 * path works on whatever is open, including a file the user picked outside the roots.
 */
export class ModelLiveView {
  private state: ModelViewState = EMPTY_MODEL_STATE;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastReport: ModelBuildReport | null = null;
  private lastGlb: string | null = null;
  private waiters: Waiter[] = [];
  private readSeq = 0;
  private captures = new Map<string, PendingCapture>();
  private readonly debounceMs: number;
  private readonly buildTimeoutMs: number;
  private readonly captureTimeoutMs: number;

  constructor(
    private readonly events: ModelLiveViewEvents,
    options: ModelLiveViewOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.buildTimeoutMs = options.buildTimeoutMs ?? 30_000;
    this.captureTimeoutMs = options.captureTimeoutMs ?? 15_000;
  }

  current(): ModelViewState {
    return this.state;
  }

  /** The GLB written for the current generation, if any. */
  glbPath(): string | null {
    return this.lastGlb;
  }

  async open(path: string): Promise<ModelViewState> {
    const kind = modelKindFor(path);
    if (!kind) throw new Error(`Not a model file: ${path}. Use a .model.js, .glb, .gltf or .stl file.`);
    this.stopWatching();
    this.lastReport = null;
    this.lastGlb = null;
    const { source, missing } = await this.read(path, kind === 'model');
    this.publish({ path, kind, generation: this.state.generation + 1, source, missing });
    this.startWatching(path);
    return this.state;
  }

  close(): void {
    this.stopWatching();
    this.lastReport = null;
    this.lastGlb = null;
    this.publish({ ...EMPTY_MODEL_STATE, generation: this.state.generation + 1 });
  }

  /**
   * Re-read the file now rather than waiting for the watcher's debounce, so a tool call made
   * straight after an edit never sees the previous build.
   */
  async refresh(): Promise<void> {
    const { path, kind } = this.state;
    if (!path || !kind) return;
    const seq = ++this.readSeq;
    const { source, missing } = await this.read(path, kind === 'model');
    if (seq !== this.readSeq || this.state.path !== path) return;
    // Binary assets read as null both times; their content changes arrive via refreshFromWatch.
    if (source === this.state.source && missing === this.state.missing) return;
    this.lastGlb = null;
    this.publish({ ...this.state, source, missing, generation: this.state.generation + 1 });
  }

  reportBuild(report: ModelBuildReport): void {
    if (report.generation !== this.state.generation) return;
    this.lastReport = report;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(report);
  }

  /** The build report for the file as it is on disk now. */
  async waitForBuild(): Promise<ModelBuildReport> {
    await this.refresh();
    if (!this.state.path) throw new Error('No model is open.');
    if (this.state.missing) throw new Error(`The model file no longer exists: ${this.state.path}`);
    if (this.lastReport && this.lastReport.generation === this.state.generation) return this.lastReport;
    return new Promise<ModelBuildReport>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: report => {
          clearTimeout(timer);
          resolve(report);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(entry => entry !== waiter);
        reject(new Error('The model pane did not finish building. Is a Bike4Mind window open on this session?'));
      }, this.buildTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  /**
   * Writes the sibling `.glb` of the open `.model.js`, and nothing else; an opened asset has no
   * sibling, so it is never overwritten. Stale generations are dropped, before the write and again
   * before the rename into place, so an older build that finishes writing last cannot win.
   */
  async writeGlb(generation: number, bytes: Uint8Array): Promise<string | null> {
    const { path, kind } = this.state;
    if (generation !== this.state.generation || kind !== 'model' || !path || this.state.missing) return null;
    const target = siblingGlbPath(path);
    if (!target) return null;
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    if (generation !== this.state.generation) {
      await rm(temporary, { force: true });
      return null;
    }
    await rename(temporary, target);
    this.lastGlb = target;
    return target;
  }

  /** Read-modify-write of one param's default value; false means nothing was written. */
  async setParam(key: string, value: number): Promise<boolean> {
    const { path, kind } = this.state;
    if (kind !== 'model' || !path) return false;
    const source = await readFile(path, 'utf8').catch(() => null);
    if (source === null) return false;
    const next = writeParamValue(source, key, value);
    if (next === null) return false;
    if (next !== source) await writeFile(path, next, 'utf8');
    return true;
  }

  /** Bytes of the open binary asset (glb/gltf/stl); the renderer cannot read the disk itself. */
  async readAsset(): Promise<Uint8Array | null> {
    const { path, kind } = this.state;
    if (!path || !kind || kind === 'model') return null;
    return readFile(path).catch(() => null);
  }

  capture(views: ModelView[], pose: ModelPose = 'rest'): Promise<Uint8Array> {
    const id = randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.captures.delete(id);
        reject(new Error('The model pane did not return a screenshot in time.'));
      }, this.captureTimeoutMs);
      this.captures.set(id, { resolve, reject, timer });
      if (!this.events.captureRequest({ id, views, pose })) {
        clearTimeout(timer);
        this.captures.delete(id);
        reject(new Error('No Bike4Mind window is open to render the model.'));
      }
    });
  }

  resolveCapture(id: string, result: { bytes?: Uint8Array; error?: string }): void {
    const pending = this.captures.get(id);
    if (!pending) return;
    this.captures.delete(id);
    clearTimeout(pending.timer);
    if (result.bytes && result.bytes.length) pending.resolve(result.bytes);
    else pending.reject(new Error(result.error || 'The model pane could not render a screenshot.'));
  }

  dispose(): void {
    this.stopWatching();
    for (const [id, pending] of this.captures) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The model view closed.'));
      this.captures.delete(id);
    }
  }

  private publish(next: ModelViewState): void {
    this.state = next;
    this.events.state(next);
  }

  private async read(path: string, asText: boolean): Promise<{ source: string | null; missing: boolean }> {
    try {
      if (!asText) {
        await stat(path);
        return { source: null, missing: false };
      }
      return { source: await readFile(path, 'utf8'), missing: false };
    } catch {
      return { source: null, missing: true };
    }
  }

  /**
   * Watches the directory rather than the file: editors and atomic writers replace the file by
   * rename, which ends a watch held on the old inode. Same pattern as ClaudeCodeSettings.ts.
   */
  private startWatching(path: string): void {
    const name = basename(path);
    try {
      this.watcher = watch(dirname(path), (_event, changed) => {
        if (changed && changed.toString() !== name) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          if (this.state.path === path) void this.refreshFromWatch(path);
        }, this.debounceMs);
      });
      this.watcher.on('error', () => this.stopWatching());
    } catch {
      this.watcher = null;
    }
  }

  private async refreshFromWatch(path: string): Promise<void> {
    if (this.state.kind !== 'model') {
      // A binary asset has no text to compare; any change is a new generation.
      const { missing } = await this.read(path, false);
      if (this.state.path !== path) return;
      this.publish({ ...this.state, missing, generation: this.state.generation + 1 });
      return;
    }
    await this.refresh();
  }

  private stopWatching(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
