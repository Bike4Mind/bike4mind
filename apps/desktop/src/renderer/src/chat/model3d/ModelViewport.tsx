import Box from '@mui/joy/Box';
import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelJoint, ModelView } from '@shared/model3d';
import { newPartNames, startBuildIn } from './buildIn';
import { changedParts, startEditFlash, type EditFlash } from './editFlash';
import { explodeModel, fitAngle, frameCamera, partsBox, poseJoints, VIEW_DIRECTIONS } from './modelScene';
import {
  addGlowLights,
  enableShadows,
  lightingGlows,
  ModelComposer,
  ModelStage,
  type StageLighting,
  viewportPixelRatio,
} from './modelStage';
import {
  recordCanvas,
  swing,
  TURNTABLE_SIZE,
  turntableCamera,
  turntablePose,
  turntableScript,
  turntableShots,
} from './turntable';

/** What the pane can ask of the viewport beyond its props. */
export type ModelViewportHandle = {
  /**
   * Records one turntable orbit of the model as it is shown now, swinging `joints`; resolves with WebM
   * bytes. `onProgress` hears each frame's place in the clip (0..1).
   */
  recordTurntable: (joints: readonly ModelJoint[], onProgress?: (progress: number) => void) => Promise<Uint8Array>;
  /** Frames the model from one side, or from the default three-quarter view when `view` is null. */
  setView: (view: ModelView | null) => void;
  /** Orbits the camera by these angles (radians): positive azimuth turns right, positive polar tilts down. */
  orbit: (azimuth: number, polar: number) => void;
  /** Moves the camera towards the target (factor below 1) or away from it (above 1). */
  zoom: (factor: number) => void;
  /**
   * Where the named parts' centre shows on screen, in CSS px from the viewport's top left: where
   * the edit prompt opens when the parts were picked from the keyboard. Null when none is shown.
   */
  partPoint: (names: readonly string[]) => ViewportPoint | null;
};

/** A point on the viewport, in CSS px from its top left. */
export type ViewportPoint = { x: number; y: number };

/** A click on a part: `additive` (shift held) adds it to the selection or takes it out. */
export type ViewportPick = { name: string | null; additive: boolean; point: ViewportPoint };

type Props = {
  object: THREE.Group | null;
  wireframe: boolean;
  /** A faded measuring grid on the floor; the floor itself is a shadow catcher either way. */
  grid: boolean;
  /** The studio softboxes or another preset; LIGHTING in modelStage.ts says what each one does. */
  lighting: StageLighting;
  dark: boolean;
  /** Dims the model while its latest build has failed. */
  dimmed: boolean;
  /** The camera re-frames when this changes (a different file), not on every rebuild. */
  frameKey: string | null;
  /** Joint angles in degrees by part name; posed on the viewer's own copy, so exports stay at rest. */
  pose: Record<string, number>;
  /** Pulls the parts apart (animated); a rebuild keeps the view exploded. */
  exploded: boolean;
  /** The parts to highlight, by name. */
  picked: readonly string[];
  /** A click (not an orbit drag) on a part, or on empty space (a null name). */
  onPick: (pick: ViewportPick) => void;
  /**
   * Parts a point-and-edit turn is waiting on. The next rebuild settles the request: the ones it
   * changed get the before/after moment (editFlash.ts), and `onEditSettled` fires either way, so a
   * turn that never touched them does not leave a later, unrelated rebuild flashing.
   */
  editing: readonly string[];
  onEditSettled: () => void;
  /** An opened asset's animation to play on a loop, by name; null shows it at rest. */
  clip: string | null;
  /** Filled with the viewport's handle while it is mounted. */
  handleRef?: MutableRefObject<ModelViewportHandle | null>;
};

/** Pointer travel, in CSS px, under which a press and release is a click rather than an orbit. */
const CLICK_SLOP = 4;
const PICK_GLOW = new THREE.Color('#2f7cf6');
/** Quiet time, in ms, after the last orbit or slider frame before the AO pass is drawn again. */
const IDLE_RENDER_DELAY = 150;
/** How long the parts take to pull apart or come back together, in ms. */
const EXPLODE_MS = 700;

/** Tints the picked parts' (cloned, per-view) materials so they read as selected; clears the rest. */
function highlightParts(root: THREE.Object3D, names: readonly string[]): void {
  root.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material as THREE.MeshStandardMaterial;
    const picked = names.includes(child.name);
    // A part's own glow (partMaterial records it) comes back when it is no longer picked.
    const own = typeof material.userData.emissive === 'number' ? material.userData.emissive : 0x000000;
    const ownIntensity =
      typeof material.userData.emissiveIntensity === 'number' ? material.userData.emissiveIntensity : 1;
    if (picked) material.emissive.copy(PICK_GLOW);
    else material.emissive.setHex(own, THREE.LinearSRGBColorSpace);
    material.emissiveIntensity = picked ? 0.45 : ownIntensity;
  });
}

type Viewer = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  stage: ModelStage;
  composer: ModelComposer;
  /** Draws a quick frame now (no AO) and the full one once nothing has changed for a moment. */
  render: () => void;
  /** Frames the current model again, unless the user has moved the camera since it was framed. */
  reframe: () => void;
} & ModelViewportHandle;

/** The interactive three.js view: orbit (drag), zoom (wheel) and pan (right drag), rendered on demand. */
export function ModelViewport({
  object,
  wireframe,
  grid,
  lighting,
  dark,
  dimmed,
  frameKey,
  pose,
  exploded,
  picked,
  onPick,
  editing,
  onEditSettled,
  clip,
  handleRef,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const framedFor = useRef<string | null>(null);
  const shownObject = useRef<THREE.Group | null>(null);
  const shownCopy = useRef<THREE.Group | null>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  // How far apart the parts are now (0..1); the explode animation moves it towards `exploded`.
  const explodeAmount = useRef(0);
  const buildFrame = useRef(0);
  // The parts printing in and when they started, kept across rebuilds so a second pass of the same
  // model (a re-render, a status change) carries the build on rather than cutting it short.
  const building = useRef<{ frameKey: string | null; names: Set<string>; start: number } | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const onEditSettledRef = useRef(onEditSettled);
  onEditSettledRef.current = onEditSettled;
  const flash = useRef<{ frame: number; run: EditFlash } | null>(null);
  // Set by the user orbiting, zooming or panning; until then a resize re-frames, because the first
  // frame is often taken before the pane has its size and a tall pane would crop the model.
  const userMoved = useRef(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // No canvas MSAA: frames go through the composer, whose own target is multisampled.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(viewportPixelRatio(window.devicePixelRatio));
    // Parts print in behind a clip plane (buildIn.ts).
    renderer.localClippingEnabled = true;
    element.appendChild(renderer.domElement);
    renderer.domElement.dataset.testid = 'model-pane-canvas';
    const scene = new THREE.Scene();
    const stage = new ModelStage(scene, renderer);
    const content = new THREE.Group();
    scene.add(content);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const composer = new ModelComposer(renderer, scene, camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    // AO costs a few ms a frame at retina size: orbiting, sliders and playback draw without it.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // While a turntable records, it alone draws: orbit, rebuild and resize frames would land in the clip.
    let recording = false;
    const render = () => {
      if (recording) return;
      composer.render(false);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => composer.render(true), IDLE_RENDER_DELAY);
    };
    controls.addEventListener('change', render);
    controls.addEventListener('start', () => {
      userMoved.current = true;
    });
    // A camera the user placed keeps its angle and target, and moves in or out as the pane's
    // narrower side does, so the model keeps its size in the pane instead of cropping.
    const reframe = (previousFit = fitAngle(camera)) => {
      if (!shownObject.current) return;
      if (!userMoved.current) {
        controls.target.copy(frameCamera(camera, shownObject.current));
      } else {
        const offset = camera.position.clone().sub(controls.target);
        offset.multiplyScalar(Math.sin(previousFit) / Math.sin(fitAngle(camera)));
        camera.position.copy(controls.target).add(offset);
      }
      controls.update();
    };
    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight || recording) return;
      renderer.setSize(clientWidth, clientHeight);
      composer.setSize(clientWidth, clientHeight, viewportPixelRatio(window.devicePixelRatio));
      const previousFit = fitAngle(camera);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      reframe(previousFit);
      render();
    };
    let pressedAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = pressedAt;
      pressedAt = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
      const shown = shownCopy.current;
      if (!shown) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(shown, true).find(entry => entry.object instanceof THREE.Mesh);
      onPickRef.current({
        name: hit ? hit.object.name : null,
        additive: event.shiftKey,
        point: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      });
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const setView = (view: ModelView | null) => {
      const shown = shownObject.current;
      if (!shown || recording) return;
      controls.target.copy(frameCamera(camera, shown, view === null ? VIEW_DIRECTIONS.iso : VIEW_DIRECTIONS[view]));
      // A preset is a deliberate camera; only the default view goes back to following the pane's size.
      userMoved.current = view !== null;
      controls.update();
    };
    const partPoint = (names: readonly string[]): ViewportPoint | null => {
      const shown = shownCopy.current;
      if (!shown) return null;
      const box = partsBox(shown, names);
      if (box.isEmpty()) return null;
      const centre = box.getCenter(new THREE.Vector3()).project(camera);
      const bounds = renderer.domElement.getBoundingClientRect();
      return { x: ((centre.x + 1) / 2) * bounds.width, y: ((1 - centre.y) / 2) * bounds.height };
    };
    const orbit = (azimuth: number, polar: number) => {
      if (recording) return;
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= azimuth;
      // Short of the poles, where the orbit would flip over.
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + polar, 0.05, Math.PI - 0.05);
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
      userMoved.current = true;
      controls.update();
    };
    const zoom = (factor: number) => {
      if (recording) return;
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
      camera.position.copy(controls.target).add(offset);
      userMoved.current = true;
      controls.update();
    };
    const recordTurntable = async (
      joints: readonly ModelJoint[],
      onProgress?: (progress: number) => void
    ): Promise<Uint8Array> => {
      if (recording) throw new Error('A recording is already running.');
      const shown = shownCopy.current;
      if (!shown) throw new Error('There is no model to record.');
      recording = true;
      clearTimeout(idleTimer);
      controls.enabled = false;
      const canvas = renderer.domElement;
      const startPosition = camera.position.clone();
      const startTarget = controls.target.clone();
      const { near, far } = camera;
      const startPose = { ...poseRef.current };
      const { width, height } = TURNTABLE_SIZE;
      // A fixed landscape frame at 1x; the pane letterboxes it meanwhile rather than stretching it.
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      composer.setSize(width, height, 1);
      canvas.style.objectFit = 'contain';
      camera.aspect = width / height;
      // Framed for the landscape clip from the angle the user was looking at it.
      const shots = turntableShots(camera, shown, startPosition.clone().sub(startTarget), startPose);
      try {
        return await recordCanvas(canvas, progress => {
          const shot = turntableCamera(shots, progress);
          camera.position.copy(shot.position);
          camera.lookAt(shot.target);
          const script = turntableScript(progress);
          // The current copy, since a rebuild mid-clip swaps it.
          const current = shownCopy.current;
          if (current && joints.length) poseJoints(current, turntablePose(joints, startPose, script.joints));
          if (current) explodeModel(current, script.explode);
          composer.setFocus(shot.distance);
          composer.render(true);
          onProgress?.(progress);
        });
      } finally {
        recording = false;
        composer.setFocus(null);
        camera.position.copy(startPosition);
        camera.near = near;
        camera.far = far;
        camera.lookAt(startTarget);
        if (shownCopy.current) {
          poseJoints(shownCopy.current, poseRef.current);
          explodeModel(shownCopy.current, explodeAmount.current);
        }
        canvas.style.objectFit = '';
        renderer.setPixelRatio(viewportPixelRatio(window.devicePixelRatio));
        controls.enabled = true;
        resize();
      }
    };
    viewer.current = {
      renderer,
      scene,
      camera,
      controls,
      content,
      stage,
      composer,
      render,
      reframe,
      recordTurntable,
      setView,
      orbit,
      zoom,
      partPoint,
    };
    resize();
    return () => {
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      clearTimeout(idleTimer);
      cancelAnimationFrame(buildFrame.current);
      if (flash.current) cancelAnimationFrame(flash.current.frame);
      controls.dispose();
      composer.dispose();
      stage.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      viewer.current = null;
      framedFor.current = null;
    };
  }, []);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      recordTurntable: async (joints, onProgress) => {
        if (!viewer.current) throw new Error('The model view is not ready.');
        return viewer.current.recordTurntable(joints, onProgress);
      },
      setView: view => viewer.current?.setView(view),
      orbit: (azimuth, polar) => viewer.current?.orbit(azimuth, polar),
      zoom: factor => viewer.current?.zoom(factor),
      partPoint: names => viewer.current?.partPoint(names) ?? null,
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  useEffect(() => {
    const current = viewer.current;
    if (!current) return;
    cancelAnimationFrame(buildFrame.current);
    // Parts the agent just added print in; a model opened afresh builds up whole.
    const previous = framedFor.current === frameKey ? shownObject.current : null;
    const added = object && previous !== object ? newPartNames(previous, object) : new Set<string>();
    if (flash.current) {
      cancelAnimationFrame(flash.current.frame);
      flash.current.run.finish();
      flash.current = null;
    }
    current.content.clear();
    current.stage.fit(object, { dark, grid, lighting });
    current.composer.fit(current.stage.bounds);
    current.composer.setLighting(lighting);
    shownObject.current = object;
    shownCopy.current = null;
    if (object) {
      const shown = object.clone(true);
      poseJoints(shown, poseRef.current);
      explodeModel(shown, explodeAmount.current);
      shownCopy.current = shown;
      shown.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const material = (child.material as THREE.MeshStandardMaterial).clone();
          material.wireframe = wireframe;
          material.transparent = dimmed;
          material.opacity = dimmed ? 0.35 : 1;
          child.material = material;
        }
      });
      highlightParts(shown, pickedRef.current);
      enableShadows(shown);
      if (lightingGlows(lighting)) addGlowLights(shown, current.stage.radius);
      current.content.add(shown);
      // Re-frame only when a different model opens, so a rebuild keeps the user's camera.
      if (framedFor.current !== frameKey) {
        framedFor.current = frameKey;
        userMoved.current = false;
        current.reframe();
      }
      current.controls.update();
      const carried = building.current?.frameKey === frameKey ? building.current : null;
      const names = new Set([...(carried?.names ?? []), ...added]);
      const start = carried?.start ?? performance.now();
      building.current = null;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const build = names.size && !still ? startBuildIn(shown, names, start) : null;
      const settles = !!previous && previous !== object && editingRef.current.length > 0;
      const edited = settles ? changedParts(previous, object, editingRef.current) : [];
      const run =
        previous && edited.length
          ? startEditFlash(current.content, shown, previous, edited, performance.now(), still)
          : null;
      if (run) {
        const playing = { run, frame: 0 };
        flash.current = playing;
        playing.frame = requestAnimationFrame(function step(now) {
          const going = run.step(now);
          current.render();
          if (going && flash.current === playing) playing.frame = requestAnimationFrame(step);
          else if (flash.current === playing) flash.current = null;
        });
      }
      if (settles) onEditSettledRef.current();
      if (build) {
        building.current = { frameKey, names, start };
        buildFrame.current = requestAnimationFrame(function step(now) {
          const printing = build.step(now);
          current.render();
          if (printing) buildFrame.current = requestAnimationFrame(step);
          else building.current = null;
        });
      }
    }
    current.render();
  }, [object, wireframe, grid, lighting, dark, dimmed, frameKey]);

  // A slider drag or playback only turns nodes: no re-clone, no re-frame.
  useEffect(() => {
    if (!viewer.current || !shownCopy.current) return;
    poseJoints(shownCopy.current, pose);
    viewer.current.render();
  }, [pose]);

  useEffect(() => {
    const target = exploded ? 1 : 0;
    const from = explodeAmount.current;
    const current = viewer.current;
    const shown = shownCopy.current;
    if (from === target || !current || !shown) {
      explodeAmount.current = target;
      return;
    }
    const { camera, controls } = current;
    // The camera glides to fit the parts where they end up, from the angle the user is looking at.
    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    const direction = fromPosition.clone().sub(fromTarget);
    explodeModel(shown, target);
    const toTarget = frameCamera(camera, shown, [direction.x, direction.y, direction.z]);
    const toPosition = camera.position.clone();
    camera.position.copy(fromPosition);
    explodeModel(shown, from);
    const started = performance.now();
    // Timed by the share of the travel still left, so reversing midway is not slower.
    const duration = EXPLODE_MS * Math.abs(target - from);
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - started) / duration);
      const eased = swing(t / 2);
      explodeAmount.current = from + (target - from) * eased;
      const copy = shownCopy.current;
      if (copy) explodeModel(copy, explodeAmount.current);
      camera.position.lerpVectors(fromPosition, toPosition, eased);
      controls.target.lerpVectors(fromTarget, toTarget, eased);
      controls.update();
      current.render();
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [exploded]);

  useEffect(() => {
    if (!viewer.current || !shownCopy.current) return;
    highlightParts(shownCopy.current, picked);
    viewer.current.render();
  }, [picked]);

  // Declared after the rebuild effect, so on a new object it runs against the fresh copy.
  useEffect(() => {
    const current = viewer.current;
    const shown = shownCopy.current;
    const animation = clip === null ? undefined : shown?.animations.find(entry => entry.name === clip);
    if (!current || !shown || !animation) return;
    // The mixer leaves nodes where the clip last put them; put them back when playback stops.
    const rest = new Map<THREE.Object3D, [THREE.Vector3, THREE.Quaternion, THREE.Vector3]>();
    shown.traverse(node => rest.set(node, [node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
    const mixer = new THREE.AnimationMixer(shown);
    mixer.clipAction(animation).play();
    const clock = new THREE.Clock();
    let frame = requestAnimationFrame(function step() {
      mixer.update(clock.getDelta());
      current.render();
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
      mixer.stopAllAction();
      mixer.uncacheRoot(shown);
      for (const [node, [position, quaternion, scale]] of rest) {
        node.position.copy(position);
        node.quaternion.copy(quaternion);
        node.scale.copy(scale);
      }
      current.render();
    };
  }, [clip, object]);

  return <Box ref={host} sx={{ position: 'absolute', inset: 0 }} data-testid="model-pane-viewport" />;
}
