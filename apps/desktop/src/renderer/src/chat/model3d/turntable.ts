import * as THREE from 'three';
import type { ModelJoint, ModelLighting } from '@shared/model3d';
import { explodeModel, frameCamera, openPose, poseJoints, sceneJoints, VIEW_DIRECTIONS } from './modelScene';
import { addGlowLights, enableShadows, ModelComposer, ModelStage } from './modelStage';

/**
 * A turntable clip of the model pane: one full orbit while every joint swings through its range and
 * back and the parts explode and reassemble, rendered at full quality and recorded from the canvas
 * as WebM. The helpers here are pure, so the motion is testable apart from the recording.
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
 * What the clip does at `progress` (0..1): the joints swing through their range over the first half
 * of the orbit, then the parts pull apart and come back together over the second, so the two never
 * compete for the shot. `joints` is the progress to pass turntablePose; `explode` is explodeModel's amount.
 */
export function turntableScript(progress: number): { joints: number; explode: number } {
  const doubled = 2 * THREE.MathUtils.clamp(progress, 0, 1);
  return { joints: Math.min(1, doubled), explode: swing(Math.max(0, doubled - 1)) };
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

/** Where the camera aims and how far back it stands. */
export type TurntableShot = { target: THREE.Vector3; distance: number };

/**
 * The clip's framings from `direction`: the model in its rest pose, with its joints open, and fully
 * exploded. The camera moves between them as the joints swing and the parts pull apart (see
 * turntableCamera), so the model fills the frame through every phase. Leaves `subject` in
 * `restPose`, assembled, and the camera's clip planes set for the widest shot.
 */
export type TurntableShots = {
  direction: THREE.Vector3;
  closed: TurntableShot;
  open: TurntableShot;
  exploded: TurntableShot;
};

/** How far the camera cranes up and back down over the clip, in radians of elevation. */
const CRANE = 0.12;
/** The share of the frame's half-height (or half-width) the model fills at its widest. */
const FILL = 0.85;
/** Orbit angles a shot is checked from, so it fits all the way round. */
const FIT_AZIMUTHS = 24;

/** The corners of each mesh's own box, in world space: a far tighter hull than one box round them all. */
function hullPoints(subject: THREE.Object3D): THREE.Vector3[] {
  subject.updateMatrixWorld(true);
  const points: THREE.Vector3[] = [];
  subject.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry: THREE.BufferGeometry = node.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box || box.isEmpty()) return;
    for (let corner = 0; corner < 8; corner += 1) {
      points.push(
        new THREE.Vector3(
          corner & 1 ? box.max.x : box.min.x,
          corner & 2 ? box.max.y : box.min.y,
          corner & 4 ? box.max.z : box.min.z
        ).applyMatrix4(node.matrixWorld)
      );
    }
  });
  return points;
}

/**
 * Aims at the centre of `subject`'s parts and stands back just far enough that they fit the frame from
 * every angle of the orbit, cranes included. Fitted to the parts' boxes, not a bounding sphere, so a
 * long or flat model fills a wide frame rather than sitting small in the middle of it.
 */
export function orbitShot(
  camera: THREE.PerspectiveCamera,
  subject: THREE.Object3D,
  direction: THREE.Vector3
): TurntableShot {
  const points = hullPoints(subject);
  if (!points.length) return { target: new THREE.Vector3(), distance: 1 };
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const offsets = points.map(point => point.sub(target));
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * FILL;
  const tanHorizontal = tanVertical * camera.aspect;
  const base = new THREE.Spherical().setFromVector3(direction);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const view = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  let distance = 0;
  for (let step = 0; step < FIT_AZIMUTHS; step += 1) {
    for (const crane of [-CRANE, CRANE]) {
      const phi = THREE.MathUtils.clamp(base.phi + crane, 0.05, Math.PI - 0.05);
      view.setFromSphericalCoords(1, phi, base.theta + (2 * Math.PI * step) / FIT_AZIMUTHS);
      right.crossVectors(worldUp, view).normalize();
      up.crossVectors(view, right);
      for (const offset of offsets) {
        // A corner fits when its sideways reach is within the frame's at its depth from the camera.
        const along = offset.dot(view);
        distance = Math.max(
          distance,
          along + Math.abs(offset.dot(right)) / tanHorizontal,
          along + Math.abs(offset.dot(up)) / tanVertical
        );
      }
    }
  }
  return { target, distance };
}

export function turntableShots(
  camera: THREE.PerspectiveCamera,
  subject: THREE.Object3D,
  direction: THREE.Vector3,
  restPose: Readonly<Record<string, number>>
): TurntableShots {
  const unit = direction.clone().normalize();
  poseJoints(subject, openPose(subject));
  const open = orbitShot(camera, subject, unit);
  poseJoints(subject, restPose);
  const closed = orbitShot(camera, subject, unit);
  explodeModel(subject, 1);
  const exploded = orbitShot(camera, subject, unit);
  // Clip planes for the widest shot, which frameCamera sets with room to spare.
  frameCamera(camera, subject, [unit.x, unit.y, unit.z]);
  explodeModel(subject, 0);
  return { direction: unit, closed, open, exploded };
}

const lerpShot = (from: TurntableShot, to: TurntableShot, amount: number): TurntableShot => ({
  target: from.target.clone().lerp(to.target, amount),
  distance: THREE.MathUtils.lerp(from.distance, to.distance, amount),
});

/**
 * The camera at `progress` (0..1) of a clip: one turn about the model with a gentle crane up and
 * back down, moving in and out with the shots as the joints swing and the parts explode, so the
 * model stays framed. Ends where it starts, so the clip loops.
 */
export function turntableCamera(shots: TurntableShots, progress: number): TurntableShot & { position: THREE.Vector3 } {
  const script = turntableScript(progress);
  const posed = lerpShot(shots.closed, shots.open, swing(script.joints));
  const { target, distance } = lerpShot(posed, shots.exploded, script.explode);
  const spherical = new THREE.Spherical().setFromVector3(shots.direction);
  spherical.theta += 2 * Math.PI * progress;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - CRANE * Math.sin(2 * Math.PI * progress), 0.05, Math.PI - 0.05);
  spherical.radius = distance;
  return { target, distance, position: new THREE.Vector3().setFromSpherical(spherical).add(target) };
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
 * longer to draw slows the motion rather than dropping a step of it. The window's background timer
 * throttling is lifted meanwhile, or a backgrounded app would record in slow motion. Resolves with
 * the WebM bytes.
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
  await window.b4m.model.setRecording(true);
  try {
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
  } finally {
    track.stop();
    await window.b4m.model.setRecording(false);
  }
  return new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
}

/**
 * A turntable of `root` for the agent's model_record, rendered off screen like the contact sheet:
 * a renderer of its own at TURNTABLE_SIZE, framed from the iso view so the clip does not depend
 * on where the user left the pane's camera. Joints swing from the modelled pose, then the parts
 * explode and reassemble (turntableScript). Resolves with WebM.
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
    // The stage is fitted open and exploded, the widest the clip gets, so nothing leaves its light.
    poseJoints(subject, openPose(subject));
    explodeModel(subject, 1);
    stage.fit(subject, { dark, grid: false, lighting });
    composer.fit(stage.bounds);
    composer.setLighting(lighting);
    explodeModel(subject, 0);
    poseJoints(subject, {});
    const iso = VIEW_DIRECTIONS.iso;
    const shots = turntableShots(camera, subject, new THREE.Vector3(iso[0], iso[1], iso[2]), {});
    if (lighting === 'night') addGlowLights(subject, stage.radius);
    const joints = sceneJoints(subject);
    return await recordCanvas(renderer.domElement, progress => {
      const shot = turntableCamera(shots, progress);
      camera.position.copy(shot.position);
      camera.lookAt(shot.target);
      const script = turntableScript(progress);
      poseJoints(subject, turntablePose(joints, {}, script.joints));
      explodeModel(subject, script.explode);
      composer.setFocus(shot.distance);
      composer.render(true);
    });
  } finally {
    composer.dispose();
    stage.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
