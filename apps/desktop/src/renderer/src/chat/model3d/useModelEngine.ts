import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import {
  EMPTY_MODEL_STATE,
  jointsOf,
  type ModelBuildOutcome,
  type ModelJoint,
  type ModelParam,
  type ModelSummary,
  type ModelViewState,
} from '@shared/model3d';
import { checkedOutcome, errorMessage, ModelEngineFrame, reportGoodFileBuild } from './modelEngineFrame';
import {
  buildModelObject,
  exportGlb,
  loadAsset,
  openPose,
  partsToStl,
  renderContactSheet,
  summarizeObject,
  summarizeParts,
} from './modelScene';
import { renderTurntable } from './turntable';

export type ModelBuildStatus = 'idle' | 'building' | 'ok' | 'error';

/**
 * `file` builds what is on disk and is the one that writes the GLB and reports to main (which the
 * model tools wait on); `preview` (a slider drag) and `print` (STL export) only show or export.
 */
type BuildPurpose = 'file' | 'preview' | 'print';

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
  /** The parts that turn, for the pane's joint sliders. Empty for loaded assets. */
  joints: ModelJoint[];
  /** Slider angles in degrees by part name; the viewer's pose only, never written or exported. */
  jointAngles: Record<string, number>;
  /** Animation names in an opened GLB, for the pane's play buttons. Empty for model files. */
  clips: string[];
  setJointAngles(angles: Record<string, number>): void;
  previewParam(key: string, value: number): void;
  commitParam(key: string, value: number): Promise<void>;
  exportFile(format: 'glb' | 'stl'): Promise<string | null>;
  openFile(): Promise<void>;
};

type Tracked = { sessionId: string | null; state: ModelViewState };

/**
 * Drives the model pane for the conversation on screen (`sessionId`): follows that conversation's
 * open file in main, builds `.model.js` sources in the sandboxed engine frame, loads binary assets,
 * reports each generation's result to main (which the model tools wait on), keeps the sibling GLB
 * fresh and answers that conversation's screenshot requests. Mounted once in ChatShell so all of
 * that keeps working while the pane itself is collapsed; useModelBackgroundBuilds does the same for
 * every other conversation.
 */
export function useModelEngine(dark: boolean, sessionId: string | null): ModelEngine {
  const [tracked, setTracked] = useState<Tracked>({ sessionId: null, state: EMPTY_MODEL_STATE });
  // Until this conversation's own state arrives it has no model, never the previous chat's.
  const state = sessionId !== null && tracked.sessionId === sessionId ? tracked.state : EMPTY_MODEL_STATE;
  const [status, setStatus] = useState<ModelBuildStatus>('idle');
  const [error, setError] = useState<ModelEngine['error']>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [summary, setSummary] = useState<ModelSummary | null>(null);
  const [params, setParams] = useState<Record<string, ModelParam>>({});
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const [joints, setJoints] = useState<ModelJoint[]>([]);
  const [clips, setClips] = useState<string[]>([]);
  const [jointAngles, setJointAnglesState] = useState<Record<string, number>>({});
  // Reset during render, not in an effect, so the previous conversation's model is never painted.
  const [shownSession, setShownSession] = useState(sessionId);
  if (shownSession !== sessionId) {
    setShownSession(sessionId);
    setStatus('idle');
    setError(null);
    setObject(null);
    setSummary(null);
    setParams({});
    setUnsaved([]);
    setJoints([]);
    setClips([]);
    setJointAnglesState({});
  }
  const posedPath = useRef<string | null>(null);
  const engine = useRef<ModelEngineFrame | null>(null);
  const fileBuild = useRef<Promise<ModelBuildOutcome | null> | null>(null);
  const previewFrame = useRef<number | null>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const objectRef = useRef<THREE.Group | null>(null);
  const stateRef = useRef(state);
  const sessionRef = useRef(sessionId);
  const overrides = useRef<Record<string, number>>({});
  stateRef.current = state;
  sessionRef.current = sessionId;
  objectRef.current = object;

  useEffect(
    () => () => {
      engine.current?.dispose();
      engine.current = null;
      if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    },
    []
  );

  useEffect(() => {
    if (sessionId === null) return;
    let live = true;
    const unsubscribe = window.b4m.model.onState(update => {
      if (update.sessionId === sessionId) setTracked(update);
    });
    void window.b4m.model.getState(sessionId).then(next => {
      if (!live) return;
      // A broadcast may have overtaken this reply; generations only grow, so the higher one is newer.
      setTracked(current =>
        current.sessionId === sessionId && current.state.generation >= next.generation
          ? current
          : { sessionId, state: next }
      );
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);

  const build = useCallback((source: string, values: Record<string, number>, purpose: BuildPurpose = 'file') => {
    const run = (async (): Promise<ModelBuildOutcome | null> => {
      // The engine runs one build at a time, so a preview or print started now would cancel a
      // file build and lose its GLB and report: those wait for it instead.
      while (purpose !== 'file' && fileBuild.current) await fileBuild.current;
      engine.current ??= new ModelEngineFrame();
      return engine.current.build(source, values, purpose === 'print');
    })();
    if (purpose === 'file') {
      fileBuild.current = run;
      void run.then(() => {
        if (fileBuild.current === run) fileBuild.current = null;
      });
    }
    return run;
  }, []);

  /** `writeGlb` is a file build's, which also writes the GLB and reports to main; a preview only shows. */
  const showOutcome = useCallback(
    async (session: string, generation: number, built: ModelBuildOutcome, writeGlb: boolean) => {
      if (sessionRef.current !== session || stateRef.current.generation !== generation) return;
      const outcome = checkedOutcome(built);
      if (!outcome.ok) {
        setStatus('error');
        setError({ message: outcome.error, line: outcome.line });
        if (writeGlb)
          await window.b4m.model.reportBuild(session, {
            generation,
            ok: false,
            error: outcome.error,
            line: outcome.line,
          });
        return;
      }
      const next = buildModelObject(outcome.parts, outcome.units);
      const nextSummary = summarizeParts(outcome.parts, outcome.params, outcome.units);
      setJoints(jointsOf(outcome.parts));
      setClips([]);
      setObject(next);
      setSummary(nextSummary);
      setParams(outcome.params);
      setStatus('ok');
      setError(null);
      if (writeGlb) await reportGoodFileBuild(session, generation, next, nextSummary);
    },
    []
  );

  useEffect(() => {
    const { kind, source, generation, missing, path } = state;
    overrides.current = {};
    if (sessionId === null) return;
    setUnsaved([]);
    // A rebuild keeps the pose so a lid held open stays open while editing; another file starts closed.
    if (posedPath.current !== path) {
      posedPath.current = path;
      setJointAnglesState({});
    }
    if (!path || !kind) {
      setStatus('idle');
      setError(null);
      setObject(null);
      setSummary(null);
      setParams({});
      setJoints([]);
      setClips([]);
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
          if (outcome && !cancelled) await showOutcome(sessionId, generation, outcome, true);
          return;
        }
        const bytes = await window.b4m.model.readAsset(sessionId);
        if (!bytes) throw new Error('The file could not be read.');
        const loaded = await loadAsset(kind, bytes);
        if (cancelled) return;
        const loadedSummary = summarizeObject(loaded);
        setJoints([]);
        setClips(loaded.animations.map(clip => clip.name));
        setObject(loaded);
        setSummary(loadedSummary);
        setParams({});
        setStatus('ok');
        setError(null);
        await window.b4m.model.reportBuild(sessionId, { generation, ok: true, summary: loadedSummary });
      } catch (caught) {
        if (cancelled) return;
        const message = errorMessage(caught);
        setStatus('error');
        setError({ message });
        await window.b4m.model.reportBuild(sessionId, { generation, ok: false, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, state, build, showOutcome]);

  useEffect(
    () =>
      window.b4m.model.onCaptureRequest(request => {
        const { sessionId: session, id } = request;
        // Another conversation's model is rendered by useModelBackgroundBuilds.
        if (session !== sessionRef.current) return;
        const current = objectRef.current;
        if (!current) {
          window.b4m.model.captureResult({ id, error: 'The model pane has nothing to show yet.' });
          return;
        }
        const rendered =
          request.kind === 'turntable'
            ? renderTurntable(current, request.lighting, darkRef.current)
            : renderContactSheet(
                current,
                request.views,
                darkRef.current,
                request.pose === 'open' ? openPose(current) : {}
              );
        rendered
          .then(bytes => window.b4m.model.captureResult({ id, bytes }))
          .catch(caught => window.b4m.model.captureResult({ id, error: errorMessage(caught) }));
      }),
    []
  );

  const previewParam = useCallback(
    (key: string, value: number) => {
      const { source, kind } = stateRef.current;
      if (kind !== 'model' || source === null) return;
      overrides.current = { ...overrides.current, [key]: value };
      setParams(previous => (previous[key] ? { ...previous, [key]: { ...previous[key], value } } : previous));
      // One build per frame however fast the slider fires: each build is a fresh worker and WASM instance.
      if (previewFrame.current !== null) return;
      previewFrame.current = requestAnimationFrame(() => {
        previewFrame.current = null;
        const current = stateRef.current;
        if (current.kind !== 'model' || current.source === null) return;
        const session = sessionRef.current;
        if (session === null) return;
        void build(current.source, overrides.current, 'preview').then(outcome => {
          if (outcome) void showOutcome(session, current.generation, outcome, false);
        });
      });
    },
    [build, showOutcome]
  );

  const commitParam = useCallback(async (key: string, value: number) => {
    const session = sessionRef.current;
    if (session === null) return;
    const saved = await window.b4m.model.setParam(session, { key, value });
    setUnsaved(previous => (saved ? previous.filter(entry => entry !== key) : [...new Set([...previous, key])]));
  }, []);

  const exportFile = useCallback(
    async (format: 'glb' | 'stl') => {
      const current = objectRef.current;
      const session = sessionRef.current;
      if (!current || session === null) return null;
      if (format === 'glb') return window.b4m.model.saveExport(session, { format, bytes: await exportGlb(current) });
      const { kind, source } = stateRef.current;
      if (kind !== 'model' || source === null) return null;
      // A fresh build with every part unioned, at the current slider values, so the STL is one printable solid.
      const outcome = await build(source, overrides.current, 'print');
      if (!outcome) throw new Error('The model changed during the export. Try again.');
      if (!outcome.ok) throw new Error(`The model did not build for export: ${outcome.error}`);
      return window.b4m.model.saveExport(session, { format, bytes: partsToStl(outcome.parts) });
    },
    [build]
  );

  const openFile = useCallback(async () => {
    if (sessionRef.current !== null) await window.b4m.model.openDialog(sessionRef.current);
  }, []);

  const setJointAngles = useCallback((angles: Record<string, number>) => setJointAnglesState(angles), []);

  return {
    state,
    status,
    error,
    object,
    summary,
    params,
    unsaved,
    joints,
    jointAngles,
    clips,
    setJointAngles,
    previewParam,
    commitParam,
    exportFile,
    openFile,
  };
}
