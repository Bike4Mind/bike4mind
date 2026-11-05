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
import { isModelPaneGlb, stampModelPaneGlb } from './glbMarker';

export type ModelCaptureRequest = { id: string; views: ModelView[]; pose: ModelPose };

export type ModelLiveViewEvents = {
  state: (state: ModelViewState) => void;
  /** The renderer (webContents id) a capture would go to; null when no window can render. */
  captureTarget: () => number | null;
  /** Ask that renderer to render screenshots; false when it is gone. */
  captureRequest: (target: number, request: ModelCaptureRequest) => boolean;
};

export type ModelLiveViewOptions = {
  debounceMs?: number;
  buildTimeoutMs?: number;
  captureTimeoutMs?: number;
};

type Waiter = { from?: number; resolve: (report: ModelBuildReport) => void };
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
  private refreshing: Promise<void> | null = null;
  /** The last generation each renderer reported, by webContents id. */
  private reported = new Map<number, number>();
  private glbWrite: { generation: number; written: Promise<string | null> } | null = null;
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
    if (!kind) throw new Error(`Not a model file: ${path}. Use a .model.js, .glb or .stl file.`);
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
  refresh(): Promise<void> {
    const run = this.refreshOnce(++this.readSeq);
    this.refreshing = run;
    return run;
  }

  private async refreshOnce(seq: number): Promise<void> {
    const { path, kind } = this.state;
    if (!path || !kind) return;
    const { source, missing } = await this.read(path, kind === 'model');
    if (this.state.path !== path) return;
    // A newer read started meanwhile: its result wins, and callers wait for it rather than return early.
    if (seq !== this.readSeq) return this.refreshing ?? undefined;
    // Binary assets read as null both times; their content changes arrive via refreshFromWatch.
    if (source === this.state.source && missing === this.state.missing) return;
    this.lastGlb = null;
    this.publish({ ...this.state, source, missing, generation: this.state.generation + 1 });
  }

  /** `from` is the reporting renderer's webContents id; every app window builds each generation. */
  reportBuild(report: ModelBuildReport, from?: number): void {
    if (report.generation !== this.state.generation) return;
    this.lastReport = report;
    if (from !== undefined) this.reported.set(from, report.generation);
    const waiters = this.waiters;
    this.waiters = waiters.filter(waiter => waiter.from !== undefined && waiter.from !== from);
    for (const waiter of waiters) if (waiter.from === undefined || waiter.from === from) waiter.resolve(report);
  }

  /** The build report for the file as it is on disk now. */
  async waitForBuild(): Promise<ModelBuildReport> {
    await this.refresh();
    if (!this.state.path) throw new Error('No model is open.');
    if (this.state.missing) throw new Error(`The model file no longer exists: ${this.state.path}`);
    if (this.lastReport && this.lastReport.generation === this.state.generation) return this.lastReport;
    return this.nextReport();
  }

  private nextReport(from?: number): Promise<ModelBuildReport> {
    return new Promise<ModelBuildReport>((resolve, reject) => {
      const waiter: Waiter = {
        from,
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
   * sibling, so it is never overwritten. An existing sibling is replaced only when it carries the
   * model pane's marker (glbMarker.ts); otherwise the write is refused. Stale generations are dropped, before the write and again
   * before the rename into place, so an older build that finishes writing last cannot win.
   */
  writeGlb(generation: number, bytes: Uint8Array): Promise<string | null> {
    // Every app window builds each generation; the first write serves them all.
    if (this.glbWrite?.generation === generation) return this.glbWrite.written;
    const written = this.writeGlbOnce(generation, bytes);
    this.glbWrite = { generation, written };
    return written;
  }

  private async writeGlbOnce(generation: number, bytes: Uint8Array): Promise<string | null> {
    const { path, kind } = this.state;
    if (generation !== this.state.generation || kind !== 'model' || !path || this.state.missing) return null;
    const target = siblingGlbPath(path);
    if (!target) return null;
    const stamped = stampModelPaneGlb(bytes);
    await this.assertReplaceable(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, stamped);
      if (generation !== this.state.generation) {
        await rm(temporary, { force: true });
        return null;
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.lastGlb = target;
    return target;
  }

  /** The user approved writing the `.model.js`, never replacing a GLB they made themselves. */
  private async assertReplaceable(target: string): Promise<void> {
    let existing: Uint8Array;
    try {
      existing = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!isModelPaneGlb(existing)) {
      throw new Error(
        `${basename(target)} already exists and was not made by the model pane, so it was left alone. ` +
          'Rename or move it to let this model write its GLB.'
      );
    }
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

  /** Bytes of the open binary asset (glb/stl); the renderer cannot read the disk itself. */
  async readAsset(): Promise<Uint8Array | null> {
    const { path, kind } = this.state;
    if (!path || !kind || kind === 'model') return null;
    return readFile(path).catch(() => null);
  }

  /** Renders in one window, after that window has reported the current generation. */
  async capture(views: ModelView[], pose: ModelPose = 'rest'): Promise<Uint8Array> {
    const target = this.events.captureTarget();
    if (target === null) throw new Error('No Bike4Mind window is open to render the model.');
    if (this.reported.get(target) !== this.state.generation) await this.nextReport(target);
    const id = randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.captures.delete(id);
        reject(new Error('The model pane did not return a screenshot in time.'));
      }, this.captureTimeoutMs);
      this.captures.set(id, { resolve, reject, timer });
      if (!this.events.captureRequest(target, { id, views, pose })) {
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
