import Box from '@mui/joy/Box';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { addLights, frameCamera, poseJoints } from './modelScene';

type Props = {
  object: THREE.Group | null;
  wireframe: boolean;
  dark: boolean;
  /** Dims the model while its latest build has failed. */
  dimmed: boolean;
  /** The camera re-frames when this changes (a different file), not on every rebuild. */
  frameKey: string | null;
  /** Joint angles in degrees by part name; posed on the viewer's own copy, so exports stay at rest. */
  pose: Record<string, number>;
};

type Viewer = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  render: () => void;
  /** Frames the current model again, unless the user has moved the camera since it was framed. */
  reframe: () => void;
};

function gridFor(object: THREE.Object3D, dark: boolean): THREE.GridHelper {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.isEmpty() ? 1 : Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  // A grid a few times the footprint, rounded up to a power of ten per cell, so its squares read as units.
  const cell = 10 ** Math.floor(Math.log10(Math.max(size, 1e-3) / 2));
  const extent = Math.ceil((size * 3) / cell) * cell;
  const grid = new THREE.GridHelper(
    extent,
    Math.round(extent / cell),
    dark ? 0x59606b : 0xa9afb8,
    dark ? 0x353a42 : 0xd9dce1
  );
  grid.position.set((box.min.x + box.max.x) / 2 || 0, box.isEmpty() ? 0 : box.min.y, (box.min.z + box.max.z) / 2 || 0);
  grid.name = 'grid';
  return grid;
}

/** The interactive three.js view: orbit (drag), zoom (wheel) and pan (right drag), rendered on demand. */
export function ModelViewport({ object, wireframe, dark, dimmed, frameKey, pose }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const framedFor = useRef<string | null>(null);
  const shownObject = useRef<THREE.Group | null>(null);
  const shownCopy = useRef<THREE.Group | null>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  // Set by the user orbiting, zooming or panning; until then a resize re-frames, because the first
  // frame is often taken before the pane has its size and a tall pane would crop the model.
  const userMoved = useRef(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    element.appendChild(renderer.domElement);
    renderer.domElement.dataset.testid = 'model-pane-canvas';
    const scene = new THREE.Scene();
    addLights(scene);
    const content = new THREE.Group();
    scene.add(content);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    controls.addEventListener('start', () => {
      userMoved.current = true;
    });
    const reframe = () => {
      if (userMoved.current || !shownObject.current) return;
      controls.target.copy(frameCamera(camera, shownObject.current));
      controls.update();
    };
    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      reframe();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    viewer.current = { renderer, scene, camera, controls, content, render, reframe };
    resize();
    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      viewer.current = null;
      framedFor.current = null;
    };
  }, []);

  useEffect(() => {
    const current = viewer.current;
    if (!current) return;
    current.scene.background = new THREE.Color(dark ? '#1b1e23' : '#f4f5f7');
    current.content.clear();
    shownObject.current = object;
    shownCopy.current = null;
    if (object) {
      const shown = object.clone(true);
      poseJoints(shown, poseRef.current);
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
      current.content.add(shown, gridFor(object, dark));
      // Re-frame only when a different model opens, so a rebuild keeps the user's camera.
      if (framedFor.current !== frameKey) {
        framedFor.current = frameKey;
        userMoved.current = false;
        current.reframe();
      }
      current.controls.update();
    }
    current.render();
  }, [object, wireframe, dark, dimmed, frameKey]);

  // A slider drag or playback only turns nodes: no re-clone, no re-frame.
  useEffect(() => {
    if (!viewer.current || !shownCopy.current) return;
    poseJoints(shownCopy.current, pose);
    viewer.current.render();
  }, [pose]);

  return <Box ref={host} sx={{ position: 'absolute', inset: 0 }} data-testid="model-pane-viewport" />;
}
