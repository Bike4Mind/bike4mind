import * as THREE from 'three';
import type { ModelJoint, ModelLighting } from '@shared/model3d';
import { frameCamera, openPose, poseJoints, sceneJoints, VIEW_DIRECTIONS } from './modelScene';
import { addGlowLights, enableShadows, ModelComposer, ModelStage } from './modelStage';

/**
 * A turntable clip of the model pane: one full orbit while every joint swings through its range and
 * back, rendered at full quality and recorded from the canvas as WebM. The helpers here are pure, so
 * the motion is testable apart from the recording.
 */

export const TURNTABLE_SECONDS = 8;
export const TURNTABLE_FPS = 30;
/** The clip's frame, landscape whatever shape the pane is, so it drops into an edit as is. */
export const TURNTABLE_SIZE = { width: 1920, height: 1080 } as const;
const TURNTABLE_BITRATE = 16_000_000;

/** 0 at both ends of the clip and 1 halfway, eased, so a lid opens and closes once and loops cleanly. */
export function swing(progress: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * THREE.MathUtils.clamp(progress, 0, 1));
}

/**
 * Each joint's angle (degrees, or model units for a slide) at `progress` (0..1): from where it starts
 * out to the far end of its range and back. `start` is the pose the user left it in.
 */
export function turntablePose(
  joints: readonly ModelJoint[],
  start: Readonly<Record<string, number>>,
  progress: number
): Record<string, number> {
  const amount = swing(progress);
  return Object.fromEntries(
    joints.map(joint => {
      const [low, high] = joint.range;
      const from = THREE.MathUtils.clamp(start[joint.name] ?? 0, low, high);
      // Swing towards whichever end is further from where it starts.
      const to = Math.abs(high - from) >= Math.abs(from - low) ? high : low;
      return [joint.name, from + (to - from) * amount];
    })
  );
}

/** The camera position at `progress` (0..1) of one turn about the vertical axis through `target`. */
export function orbitPosition(start: THREE.Vector3, target: THREE.Vector3, progress: number): THREE.Vector3 {
  const offset = start.clone().sub(target);
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), 2 * Math.PI * progress);
  return offset.add(target);
}

/** The best WebM codec this Chromium records, or null when it records none. */
export function turntableMimeType(isSupported: (type: string) => boolean): string | null {
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => isSupported(type)) ?? null;
}

/** Resolves at `time` (a performance.now() reading), or at once when it has passed. */
const until = (time: number) =>
  new Promise<void>(resolve => setTimeout(resolve, Math.max(0, time - performance.now())));

/**
 * Records `canvas` while `drawFrame(progress)` draws each of the clip's frames in turn. Each frame
 * is pushed to the recorder by hand (a fixed-rate capture only sees frames the window composites,
 * which a backgrounded window may not), and frames are due at TURNTABLE_FPS: a frame that takes
 * longer to draw slows the motion rather than dropping a step of it. Resolves with the WebM bytes.
 */
export async function recordCanvas(
  canvas: HTMLCanvasElement,
  drawFrame: (progress: number) => void
): Promise<Uint8Array> {
  const mimeType = turntableMimeType(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This app cannot record WebM video.');
  const stream = canvas.captureStream(0);
  const [track] = stream.getVideoTracks() as CanvasCaptureMediaStreamTrack[];
  if (!track) throw new Error('The view could not be captured.');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: TURNTABLE_BITRATE });
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve());
    recorder.addEventListener('error', () => reject(new Error('The recording failed.')));
  });
  recorder.start();
  const frames = TURNTABLE_SECONDS * TURNTABLE_FPS;
  let due = performance.now();
  for (let frame = 0; frame <= frames; frame += 1) {
    await until(due);
    drawFrame(frame / frames);
    track.requestFrame();
    due = Math.max(due + 1000 / TURNTABLE_FPS, performance.now());
  }
  // Hold the last frame for one frame's time, so the recorder gives it a duration.
  await until(due);
  recorder.stop();
  await stopped;
  track.stop();
  return new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
}

/**
 * A turntable of `root` for the agent's model_record, rendered off screen like the contact sheet:
 * a renderer of its own at TURNTABLE_SIZE, framed from the iso view so the clip does not depend
 * on where the user left the pane's camera. Joints swing from the modelled pose. Resolves with WebM.
 */
export async function renderTurntable(
  root: THREE.Object3D,
  lighting: ModelLighting,
  dark: boolean
): Promise<Uint8Array> {
  const { width, height } = TURNTABLE_SIZE;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 1000);
  const stage = new ModelStage(scene, renderer);
  const composer = new ModelComposer(renderer, scene, camera);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    composer.setSize(width, height, 1);
    const subject = root.clone(true);
    enableShadows(subject);
    scene.add(subject);
    // Fitted and framed with every joint open, the widest the clip gets, so nothing swings out of shot.
    poseJoints(subject, openPose(subject));
    stage.fit(subject, { dark, grid: false, lighting });
    composer.fit(stage.bounds);
    composer.setLighting(lighting);
    const target = frameCamera(camera, subject, VIEW_DIRECTIONS.iso);
    const orbitStart = camera.position.clone();
    poseJoints(subject, {});
    if (lighting === 'night') addGlowLights(subject, stage.radius);
    const joints = sceneJoints(subject);
    return await recordCanvas(renderer.domElement, progress => {
      camera.position.copy(orbitPosition(orbitStart, target, progress));
      camera.lookAt(target);
      poseJoints(subject, turntablePose(joints, {}, progress));
      composer.render(true);
    });
  } finally {
    composer.dispose();
    stage.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
