import { EMPTY_MODEL_STATE, type ModelViewState } from '@shared/model3d';
import {
  type ModelCaptureRequest,
  ModelLiveView,
  type ModelLiveViewOptions,
  type ModelVersionsBinding,
} from './ModelLiveView';
import type { ModelVersionStore } from './ModelVersionStore';

export type ModelLiveViewsEvents = {
  state: (sessionId: string, state: ModelViewState) => void;
  /** The renderer (webContents id) a capture would go to; null when no window can render. */
  captureTarget: () => number | null;
  /** Ask that renderer to render one conversation's model; false when it is gone. */
  captureRequest: (target: number, request: { sessionId: string } & ModelCaptureRequest) => boolean;
  /** A conversation kept a new version; panes showing it list them again. */
  versionsChanged?: (sessionId: string) => void;
};

/**
 * One {@link ModelLiveView} per conversation, so a new chat starts with no model and switching back
 * to a chat brings its model back. Keyed by the session id, which is all both sides share: the
 * agent's tools get the view of the turn's session (ChatService), and every renderer request names
 * the session its pane is showing (modelIpc.ts). A view is made on first use and holds no watcher
 * until something is opened in it.
 */
export class ModelLiveViews {
  private views = new Map<string, ModelLiveView>();

  constructor(
    private readonly events: ModelLiveViewsEvents,
    private readonly options: ModelLiveViewOptions = {},
    /** Where kept builds go; without one nothing is kept (ModelVersionStore.ts). */
    private readonly versionStore: ModelVersionStore | null = null
  ) {}

  /** Every conversation's kept builds, also for one whose view was never opened this run. */
  get versions(): ModelVersionStore | null {
    return this.versionStore;
  }

  for(sessionId: string): ModelLiveView {
    const existing = this.views.get(sessionId);
    if (existing) return existing;
    const view = new ModelLiveView(
      {
        state: state => this.events.state(sessionId, state),
        captureTarget: this.events.captureTarget,
        captureRequest: (target, request) => this.events.captureRequest(target, { sessionId, ...request }),
      },
      this.options,
      this.bindVersions(sessionId)
    );
    this.views.set(sessionId, view);
    return view;
  }

  private bindVersions(sessionId: string): ModelVersionsBinding | null {
    const store = this.versionStore;
    if (!store) return null;
    return {
      record: input => store.record(sessionId, input),
      list: () => store.list(sessionId),
      get: number => store.get(sessionId, number),
      changed: () => this.events.versionsChanged?.(sessionId),
    };
  }

  /** The conversation's view, without making one; for renderer requests about a model already open. */
  find(sessionId: string): ModelLiveView | undefined {
    return this.views.get(sessionId);
  }

  current(sessionId: string): ModelViewState {
    return this.views.get(sessionId)?.current() ?? EMPTY_MODEL_STATE;
  }

  /** Capture ids are random UUIDs, so only the view that asked holds a given one. */
  resolveCapture(id: string, result: { bytes?: Uint8Array; error?: string }): void {
    for (const view of this.views.values()) view.resolveCapture(id, result);
  }

  /** Stops a deleted conversation's watcher, fails anything still waiting on it and drops its versions. */
  forget(sessionId: string): void {
    this.views.get(sessionId)?.dispose();
    this.views.delete(sessionId);
    void this.versionStore
      ?.remove(sessionId)
      .catch(error => console.warn(`MODEL: could not remove a deleted conversation's versions: ${String(error)}`));
  }

  dispose(): void {
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
  }
}
