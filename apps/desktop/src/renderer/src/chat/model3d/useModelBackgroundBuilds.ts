import { useEffect, useRef } from 'react';
import type * as THREE from 'three';
import type { ModelCaptureRequestEvent, ModelSummary, ModelViewState } from '@shared/model3d';
import { checkedOutcome, errorMessage, ModelEngineFrame, reportGoodFileBuild } from './modelEngineFrame';
import {
  buildModelObject,
  loadAsset,
  openPose,
  renderContactSheet,
  summarizeObject,
  summarizeParts,
} from './modelScene';
import { renderTurntable } from './turntable';

type Built = { ok: true; object: THREE.Group; summary: ModelSummary } | { ok: false; error: string; line?: number };

/** Null when a newer build in the same frame superseded this one. */
async function buildState(engine: ModelEngineFrame, sessionId: string, state: ModelViewState): Promise<Built | null> {
  if (state.kind === 'model') {
    const built = await engine.build(state.source ?? '', {}, false);
    if (!built) return null;
    const outcome = checkedOutcome(built);
    if (!outcome.ok) return { ok: false, error: outcome.error, line: outcome.line };
    return {
      ok: true,
      object: buildModelObject(outcome.parts, outcome.units),
      summary: summarizeParts(outcome.parts, outcome.params, outcome.units),
    };
  }
  try {
    const bytes = await window.b4m.model.readAsset(sessionId);
    if (!bytes || !state.kind) throw new Error('The file could not be read.');
    const loaded = await loadAsset(state.kind, bytes);
    return { ok: true, object: loaded, summary: summarizeObject(loaded) };
  } catch (caught) {
    return { ok: false, error: errorMessage(caught) };
  }
}

function hasModel(state: ModelViewState): boolean {
  return state.path !== null && state.kind !== null && !state.missing;
}

async function buildAndReport(engine: ModelEngineFrame, sessionId: string, state: ModelViewState): Promise<void> {
  if (!hasModel(state)) return;
  const { generation } = state;
  const built = await buildState(engine, sessionId, state);
  if (!built) return;
  if (!built.ok) {
    await window.b4m.model.reportBuild(sessionId, { generation, ok: false, error: built.error, line: built.line });
    return;
  }
  if (state.kind === 'model') await reportGoodFileBuild(sessionId, generation, built.object, built.summary);
  else await window.b4m.model.reportBuild(sessionId, { generation, ok: true, summary: built.summary });
}

/** Main sends a capture only after this window reported the current generation, so a fresh build matches it. */
export async function captureFromFreshBuild(
  engine: ModelEngineFrame,
  request: ModelCaptureRequestEvent,
  dark: boolean
): Promise<void> {
  const { sessionId, id } = request;
  try {
    const state = await window.b4m.model.getState(sessionId);
    const built = hasModel(state) ? await buildState(engine, sessionId, state) : null;
    if (!built?.ok) throw new Error(built ? built.error : 'The model pane has nothing to show yet.');
    const bytes =
      request.kind === 'turntable'
        ? await renderTurntable(built.object, request.lighting, dark)
        : await renderContactSheet(
            built.object,
            request.views,
            dark,
            request.pose === 'open' ? openPose(built.object) : {}
          );
    window.b4m.model.captureResult({ id, bytes });
  } catch (caught) {
    window.b4m.model.captureResult({ id, error: errorMessage(caught) });
  }
}

/**
 * Builds the models of conversations that are not on screen, so the agent's model tools keep working
 * in a background chat: every new generation gets its sibling GLB and its build report, and a
 * screenshot request is rendered from a fresh build. Nothing is shown and nothing is kept;
 * useModelEngine does all of this, and more, for the conversation on screen. Builds run one at a
 * time, in order, in this hook's own engine frame, so they never cancel the pane's.
 */
export function useModelBackgroundBuilds(activeSessionId: string | null, dark: boolean): void {
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const enqueueRef = useRef<((sessionId: string, state: ModelViewState) => void) | null>(null);

  useEffect(() => {
    const engine = new ModelEngineFrame();
    // The newest state per conversation still waiting; a run picks up whatever is newest by then.
    const waiting = new Map<string, ModelViewState>();
    let chain = Promise.resolve();
    let disposed = false;
    const run = (task: () => Promise<void>) => {
      chain = chain.then(() => (disposed ? undefined : task())).catch(() => undefined);
    };
    const enqueue = (sessionId: string, state: ModelViewState) => {
      const queued = waiting.has(sessionId);
      waiting.set(sessionId, state);
      if (queued) return;
      run(async () => {
        const latest = waiting.get(sessionId);
        waiting.delete(sessionId);
        // A conversation brought on screen meanwhile is the pane's to build.
        if (latest && sessionId !== activeRef.current) await buildAndReport(engine, sessionId, latest);
      });
    };
    enqueueRef.current = enqueue;
    const offState = window.b4m.model.onState(({ sessionId, state }) => {
      if (sessionId !== activeRef.current) enqueue(sessionId, state);
    });
    const offCapture = window.b4m.model.onCaptureRequest(request => {
      if (request.sessionId !== activeRef.current) run(() => captureFromFreshBuild(engine, request, darkRef.current));
    });
    return () => {
      disposed = true;
      enqueueRef.current = null;
      offState();
      offCapture();
      engine.dispose();
    };
  }, []);

  // The pane drops a build it was running for a conversation the user just left, which a model tool
  // in that conversation may be waiting on; build it here instead.
  const previous = useRef(activeSessionId);
  useEffect(() => {
    const left = previous.current;
    previous.current = activeSessionId;
    if (!left || left === activeSessionId) return;
    void window.b4m.model.getState(left).then(
      state => {
        if (hasModel(state)) enqueueRef.current?.(left, state);
      },
      () => undefined
    );
  }, [activeSessionId]);
}
