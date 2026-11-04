import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import {
  EMPTY_MODEL_STATE,
  partTreeError,
  type ModelBuildOutcome,
  type ModelParam,
  type ModelPartMesh,
  type ModelSummary,
  type ModelViewState,
} from '@shared/model3d';
import {
  buildModelObject,
  exportGlb,
  loadAsset,
  partsToStl,
  renderContactSheet,
  summarizeObject,
  summarizeParts,
} from './modelScene';

/** Must match MODEL_ENGINE_URL / MODEL_ENGINE_ORIGIN in main/chat/model3d/engineProtocol.ts. */
const ENGINE_URL = 'b4m-model://engine/';
const ENGINE_ORIGIN = 'b4m-model://engine';

export type ModelBuildStatus = 'idle' | 'building' | 'ok' | 'error';

export type ModelEngine = {
  state: ModelViewState;
  status: ModelBuildStatus;
  error: { message: string; line?: number } | null;
  /** The last good object; kept on an error so the pane can show it dimmed. */
  object: THREE.Group | null;
  summary: ModelSummary | null;
  params: Record<string, ModelParam>;
  /** Param keys whose last slider value could not be written back to the file. */
  unsaved: string[];
  previewParam(key: string, value: number): void;
  commitParam(key: string, value: number): Promise<void>;
  exportFile(format: 'glb' | 'stl'): Promise<string | null>;
  openFile(): Promise<void>;
};

type EngineFrame = { frame: HTMLIFrameElement; ready: Promise<void> };

function mountEngineFrame(): EngineFrame {
  const frame = document.createElement('iframe');
  frame.src = ENGINE_URL;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.testid = 'model-engine-frame';
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  const ready = new Promise<void>(resolve => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'engine-ready') return;
      window.removeEventListener('message', onMessage);
      resolve();
    };
    window.addEventListener('message', onMessage);
  });
  document.body.appendChild(frame);
  return { frame, ready };
}

/**
 * Drives the model pane: follows main's open file, builds `.model.js` sources in the sandboxed
 * engine frame, loads binary assets, reports each generation's result to main (which the model
 * tools wait on), keeps the sibling GLB fresh and answers screenshot requests. Mounted once in
 * ChatShell so all of that keeps working while the pane itself is collapsed.
 */
export function useModelEngine(dark: boolean): ModelEngine {
  const [state, setState] = useState<ModelViewState>(EMPTY_MODEL_STATE);
  const [status, setStatus] = useState<ModelBuildStatus>('idle');
  const [error, setError] = useState<ModelEngine['error']>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [summary, setSummary] = useState<ModelSummary | null>(null);
  const [params, setParams] = useState<Record<string, ModelParam>>({});
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const engine = useRef<EngineFrame | null>(null);
  const requestId = useRef(0);
  const pending = useRef<((outcome: ModelBuildOutcome | null) => void) | null>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const objectRef = useRef<THREE.Group | null>(null);
  const partsRef = useRef<ModelPartMesh[] | null>(null);
  const stateRef = useRef(state);
  const overrides = useRef<Record<string, number>>({});
  stateRef.current = state;
  objectRef.current = object;

  useEffect(() => {
    let live = true;
    const unsubscribe = window.b4m.model.onState(next => setState(next));
    void window.b4m.model.getState().then(next => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      unsubscribe();
      engine.current?.frame.remove();
      engine.current = null;
    };
  }, []);

  const build = useCallback(
    async (source: string, values: Record<string, number>): Promise<ModelBuildOutcome | null> => {
      engine.current ??= mountEngineFrame();
      const { frame, ready } = engine.current;
      await ready;
      requestId.current += 1;
      const id = requestId.current;
      // A newer build supersedes this one: its caller gets null and stops.
      pending.current?.(null);
      return new Promise(resolve => {
        const finish = (outcome: ModelBuildOutcome | null) => {
          window.removeEventListener('message', onMessage);
          if (pending.current === finish) pending.current = null;
          resolve(outcome);
        };
        const onMessage = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.data?.type !== 'built' || event.data.id !== id) return;
          finish(event.data.outcome as ModelBuildOutcome);
        };
        pending.current = finish;
        window.addEventListener('message', onMessage);
        frame.contentWindow?.postMessage({ type: 'build', id, source, params: values }, ENGINE_ORIGIN);
      });
    },
    []
  );

  const showOutcome = useCallback(async (generation: number, built: ModelBuildOutcome, writeGlb: boolean) => {
    if (stateRef.current.generation !== generation) return;
    const treeError = built.ok ? partTreeError(built.parts) : null;
    const outcome: ModelBuildOutcome = treeError ? { ok: false, error: treeError } : built;
    if (!outcome.ok) {
      setStatus('error');
      setError({ message: outcome.error, line: outcome.line });
      if (writeGlb)
        await window.b4m.model.reportBuild({ generation, ok: false, error: outcome.error, line: outcome.line });
      return;
    }
    const next = buildModelObject(outcome.parts, outcome.units);
    const nextSummary = summarizeParts(outcome.parts, outcome.params, outcome.units);
    partsRef.current = outcome.parts;
    setObject(next);
    setSummary(nextSummary);
    setParams(outcome.params);
    setStatus('ok');
    setError(null);
    if (!writeGlb) return;
    // The GLB first, so a tool woken by the report can name the file that is already on disk.
    await window.b4m.model.writeGlb({ generation, bytes: await exportGlb(next) }).catch(() => null);
    await window.b4m.model.reportBuild({ generation, ok: true, summary: nextSummary });
  }, []);

  useEffect(() => {
    const { kind, source, generation, missing, path } = state;
    overrides.current = {};
    setUnsaved([]);
    if (!path || !kind) {
      setStatus('idle');
      setError(null);
      setObject(null);
      setSummary(null);
      setParams({});
      partsRef.current = null;
      return;
    }
    if (missing) {
      setStatus('error');
      setError({ message: 'The model file no longer exists.' });
      return;
    }
    setStatus('building');
    let cancelled = false;
    void (async () => {
      try {
        if (kind === 'model') {
          const outcome = await build(source ?? '', {});
          if (outcome && !cancelled) await showOutcome(generation, outcome, true);
          return;
        }
        const bytes = await window.b4m.model.readAsset();
        if (!bytes) throw new Error('The file could not be read.');
        const loaded = await loadAsset(kind, bytes);
        if (cancelled) return;
        const loadedSummary = summarizeObject(loaded);
        partsRef.current = null;
        setObject(loaded);
        setSummary(loadedSummary);
        setParams({});
        setStatus('ok');
        setError(null);
        await window.b4m.model.reportBuild({ generation, ok: true, summary: loadedSummary });
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setStatus('error');
        setError({ message });
        await window.b4m.model.reportBuild({ generation, ok: false, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, build, showOutcome]);

  useEffect(
    () =>
      window.b4m.model.onCaptureRequest(({ id, views }) => {
        const current = objectRef.current;
        if (!current) {
          window.b4m.model.captureResult({ id, error: 'The model pane has nothing to show yet.' });
          return;
        }
        renderContactSheet(current, views, darkRef.current)
          .then(bytes => window.b4m.model.captureResult({ id, bytes }))
          .catch(caught =>
            window.b4m.model.captureResult({ id, error: caught instanceof Error ? caught.message : String(caught) })
          );
      }),
    []
  );

  const previewParam = useCallback(
    (key: string, value: number) => {
      const { source, generation, kind } = stateRef.current;
      if (kind !== 'model' || source === null) return;
      overrides.current = { ...overrides.current, [key]: value };
      setParams(previous => (previous[key] ? { ...previous, [key]: { ...previous[key], value } } : previous));
      void build(source, overrides.current).then(outcome => {
        if (outcome) void showOutcome(generation, outcome, false);
      });
    },
    [build, showOutcome]
  );

  const commitParam = useCallback(async (key: string, value: number) => {
    const saved = await window.b4m.model.setParam({ key, value });
    setUnsaved(previous => (saved ? previous.filter(entry => entry !== key) : [...new Set([...previous, key])]));
  }, []);

  const exportFile = useCallback(async (format: 'glb' | 'stl') => {
    const current = objectRef.current;
    if (!current) return null;
    const bytes =
      format === 'stl' && partsRef.current
        ? partsToStl(partsRef.current)
        : format === 'glb'
          ? await exportGlb(current)
          : null;
    if (!bytes) return null;
    return window.b4m.model.saveExport({ format, bytes });
  }, []);

  const openFile = useCallback(async () => {
    await window.b4m.model.openDialog();
  }, []);

  return { state, status, error, object, summary, params, unsaved, previewParam, commitParam, exportFile, openFile };
}
