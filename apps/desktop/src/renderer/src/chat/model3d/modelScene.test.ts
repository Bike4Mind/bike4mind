// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ModelPartMesh } from '@shared/model3d';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  fitAngle,
  buildModelObject,
  exportGlb,
  shareMetalRoughMaps,
  loadAsset,
  openPose,
  partMaterial,
  partsToStl,
  poseJoints,
  summarizeObject,
  summarizeParts,
  canExplode,
  drivingJoint,
  explodeModel,
  jointDragFrame,
  extendsPastView,
  frameBox,
} from './modelScene';

/** An axis-aligned box from 0 to (x, y, z): 8 corners, 12 triangles, wound outward. */
function box(name: string, x: number, y: number, z: number): ModelPartMesh {
  const positions = new Float32Array([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { name, color: '#8b5a2b', positions, indices };
}

describe('fitAngle', () => {
  it('is half the vertical field of view in a wide pane and narrows with a tall one', () => {
    const camera = new THREE.PerspectiveCamera(40, 2);
    expect(fitAngle(camera)).toBeCloseTo(THREE.MathUtils.degToRad(20));
    camera.aspect = 0.5;
    expect(fitAngle(camera)).toBeCloseTo(Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * 0.5));
  });
});

describe('extendsPastView', () => {
  const framedOn = (box: THREE.Box3) => {
    const camera = new THREE.PerspectiveCamera(35, 1.5, 0.01, 1000);
    camera.lookAt(frameBox(camera, box));
    return camera;
  };

  it('keeps a framed model, and a rebuild that stays inside it, in view', () => {
    const lantern = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 1));
    const camera = framedOn(lantern);
    expect(extendsPastView(camera, lantern)).toBe(false);
    expect(extendsPastView(camera, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2.1, 1)))).toBe(
      false
    );
  });

  it('flags a model that grew past the view, or reaches behind the camera', () => {
    const camera = framedOn(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 1)));
    expect(extendsPastView(camera, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 4, 1)))).toBe(true);
    const behind = camera.position.clone().multiplyScalar(2);
    expect(extendsPastView(camera, new THREE.Box3(new THREE.Vector3(0, 0, 0), behind))).toBe(true);
  });

  it('never flags an empty model', () => {
    expect(extendsPastView(new THREE.PerspectiveCamera(), new THREE.Box3())).toBe(false);
  });
});

describe('summarizeParts', () => {
  it('reports size in model axes, triangles and param values', () => {
    const summary = summarizeParts(
      [box('body', 60, 40, 30)],
      { width: { value: 60, min: 1, max: 100, step: 1 } },
      'mm'
    );
    expect(summary).toEqual({ parts: ['body'], size: [60, 40, 30], units: 'mm', triangles: 12, params: { width: 60 } });
  });
});

describe('partsToStl', () => {
  it('writes a binary STL of 84 + 50 bytes per triangle with an outward normal', () => {
    const stl = partsToStl([box('a', 1, 1, 1), box('b', 2, 2, 2)]);
    expect(stl.byteLength).toBe(84 + 50 * 24);
    const view = new DataView(stl.buffer);
    expect(view.getUint32(80, true)).toBe(24);
    // First triangle is the bottom face (z = 0), so its normal points down.
    expect(view.getFloat32(84 + 8, true)).toBeCloseTo(-1);
  });
});

describe('buildModelObject / summarizeObject', () => {
  it('keeps model axes when summarizing the Y-up scene object', () => {
    const root = buildModelObject([box('body', 60, 40, 30)], 'mm');
    const summary = summarizeObject(root);
    expect(summary.size[0]).toBeCloseTo(60);
    expect(summary.size[1]).toBeCloseTo(40);
    expect(summary.size[2]).toBeCloseTo(30);
    expect(summary.parts).toEqual(['body']);
    expect(summary.triangles).toBe(12);
  });
});

describe('exportGlb', () => {
  it('writes a binary glTF scaled to metres that loads back', async () => {
    const glb = await exportGlb(buildModelObject([box('body', 1000, 500, 250)], 'mm'));
    expect(new TextDecoder().decode(glb.slice(0, 4))).toBe('glTF');
    const loaded = summarizeObject(await loadAsset('glb', glb));
    expect(loaded.size[0]).toBeCloseTo(1);
    expect(loaded.size[1]).toBeCloseTo(0.5);
    expect(loaded.size[2]).toBeCloseTo(0.25);
    expect(loaded.units).toBe('m');
  });

  it('exports a procedurally textured part as one metallic-roughness texture', async () => {
    // jsdom has no canvas: stand in for the 2D context the exporter writes its images through.
    // Like a real one, drawImage rejects anything that is not an image or canvas.
    const context = {
      putImageData: vi.fn(),
      drawImage: vi.fn(() => {
        throw new TypeError('drawImage: not an image source');
      }),
    };
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number
        ) {}
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback =>
      callback(new Blob([new Uint8Array(4)]))
    );
    try {
      const glb = await exportGlb(buildModelObject([{ ...box('plank', 100, 20, 10), texture: 'wood' }], 'mm'));
      const jsonLength = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(glb.slice(20, 20 + jsonLength)));
      expect(json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
      expect(context.drawImage).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('hands the exporter one packed map for a textured part, leaving the viewer material alone', () => {
    const root = buildModelObject([{ ...box('plank', 100, 20, 10), texture: 'wood' }, box('plain', 1, 1, 1)], 'mm');
    const viewer = (root.getObjectByName('plank') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const copy = root.clone(true);
    shareMetalRoughMaps(copy);
    const plank = (copy.getObjectByName('plank') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(plank.roughnessMap).toBeInstanceOf(THREE.DataTexture);
    expect(plank.metalnessMap).toBe(plank.roughnessMap);
    expect(viewer.metalnessMap).toBeNull();
    const plain = (copy.getObjectByName('plain') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(plain.metalnessMap).toBeNull();
  });
});

describe('loadAsset (stl)', () => {
  describe('shading and materials', () => {
    const ball = (extra: Partial<ModelPartMesh> = {}): ModelPartMesh => {
      const sphere = new THREE.SphereGeometry(10, 16, 12);
      return {
        name: 'knob',
        color: '#c9a227',
        positions: new Float32Array(sphere.getAttribute('position').array),
        indices: new Uint32Array(sphere.getIndex()!.array),
        ...extra,
      };
    };
    const normalsOf = async (part: ModelPartMesh) => {
      const bytes = await exportGlb(buildModelObject([part], 'mm'));
      const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
      const mesh = loaded.scene.getObjectByName(part.name) as THREE.Mesh;
      return { mesh, normals: (mesh.geometry as THREE.BufferGeometry).getAttribute('normal') };
    };

    it('writes one normal per face for a faceted part, so an engine shades it low-poly', async () => {
      const { normals } = await normalsOf(box('body', 60, 40, 30));
      for (let index = 0; index < normals.count; index++) {
        const components = [normals.getX(index), normals.getY(index), normals.getZ(index)].map(Math.abs);
        // A box face's normal is one axis: no corner-averaged diagonals.
        expect(components.filter(value => value > 0.999)).toHaveLength(1);
      }
    });

    it('blends normals across a smooth part, so neighbours at a vertex agree', async () => {
      const flat = (await normalsOf(ball())).normals;
      const smooth = (await normalsOf(ball({ smooth: true }))).normals;
      // Each triangle's three normals are equal when faceted and differ when blended.
      const spread = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
        let total = 0;
        for (let index = 0; index < attribute.count; index += 3) {
          const a = new THREE.Vector3().fromBufferAttribute(attribute, index);
          total += a.distanceTo(new THREE.Vector3().fromBufferAttribute(attribute, index + 1));
        }
        return total;
      };
      expect(spread(flat)).toBeCloseTo(0);
      expect(spread(smooth)).toBeGreaterThan(1);
    });

    it('keeps metalness and roughness in the GLB material', async () => {
      const { mesh } = await normalsOf(ball({ metalness: 1, roughness: 0.4 }));
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.metalness).toBeCloseTo(1);
      expect(material.roughness).toBeCloseTo(0.4);
    });

    it('exports glass, varnish, cloth and glow as KHR material extensions, thickness in metres', async () => {
      const { mesh } = await normalsOf(
        ball({
          clearcoat: 0.6,
          sheen: 0.5,
          transmission: 1,
          ior: 1.45,
          thickness: 4,
          emissive: '#ff8000',
          emissiveIntensity: 3,
        })
      );
      const material = mesh.material as THREE.MeshPhysicalMaterial;
      expect(material.clearcoat).toBeCloseTo(0.6);
      expect(material.transmission).toBeCloseTo(1);
      expect(material.ior).toBeCloseTo(1.45);
      // 4 mm, in the GLB's metres.
      expect(material.thickness).toBeCloseTo(0.004);
      expect(material.sheen).toBeGreaterThan(0);
      const sheenColor = material.sheenColor.clone().convertLinearToSRGB();
      // The part's own colour at half strength.
      expect(sheenColor.r).toBeGreaterThan(sheenColor.b);
      expect(material.emissive.getHexString()).toBe('ff8000');
      expect(material.emissiveIntensity).toBeCloseTo(3);
    });

    it('leaves the viewer object at model units when the GLB scales thickness', async () => {
      const root = buildModelObject([ball({ transmission: 1, thickness: 4 })], 'mm');
      await exportGlb(root);
      const mesh = root.getObjectByName('knob') as THREE.Mesh;
      expect((mesh.material as THREE.MeshPhysicalMaterial).thickness).toBe(4);
    });
  });

  describe('partMaterial', () => {
    it('reads the colour as sRGB hex and keeps a plain part free of extension features', () => {
      const material = partMaterial(box('body', 1, 1, 1));
      expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
      expect(material.color.getHexString(THREE.SRGBColorSpace)).toBe('8b5a2b');
      expect([material.clearcoat, material.sheen, material.transmission]).toEqual([0, 0, 0]);
      expect(material.emissive.getHex()).toBe(0);
    });

    it('gives a textured part its maps, and brushed metal its anisotropy, with bump scaled to the units', () => {
      const wood = partMaterial({ ...box('plank', 1, 1, 1), texture: 'wood' });
      expect(wood.map).not.toBeNull();
      expect(wood.roughnessMap).not.toBeNull();
      expect(wood.anisotropy).toBe(0);
      const brushed = partMaterial({ ...box('plate', 1, 1, 1), texture: 'brushed' }, 'm');
      expect(brushed.anisotropy).toBeGreaterThan(0);
      expect(brushed.bumpScale).toBeCloseTo(
        partMaterial({ ...box('plate', 1, 1, 1), texture: 'brushed' }).bumpScale / 1000
      );
      expect(partMaterial(box('body', 1, 1, 1)).map).toBeNull();
    });

    it('records the part glow, so a pick highlight can put it back', () => {
      const material = partMaterial({ ...box('lamp', 1, 1, 1), emissive: '#ffffff', emissiveIntensity: 2 });
      expect(material.userData).toMatchObject({ emissive: 0xffffff, emissiveIntensity: 2 });
    });
  });

  it('round-trips an exported STL as millimetres', async () => {
    const summary = summarizeObject(await loadAsset('stl', partsToStl([box('a', 10, 20, 30)])));
    expect(summary.units).toBe('mm');
    expect(summary.size[0]).toBeCloseTo(10);
    expect(summary.size[2]).toBeCloseTo(30);
  });
});

describe('part pivots and parents', () => {
  /** A body 0..60 x 0..40 x 0..30 and a lid on top of it, hinged along its back top edge. */
  const parts = () => {
    const lid = box('lid', 60, 40, 10);
    for (let index = 2; index < lid.positions.length; index += 3) lid.positions[index] += 30;
    return [{ ...lid, pivot: [0, 40, 30] as [number, number, number], parent: 'body' }, box('body', 60, 40, 30)];
  };

  it('nests the lid under the body with its origin at the hinge, without moving it', () => {
    const input = parts();
    const root = buildModelObject(input, 'mm');
    const lid = root.getObjectByName('lid') as THREE.Mesh;
    expect(lid.parent?.name).toBe('body');
    expect(lid.position.toArray()).toEqual([0, 40, 30]);
    // Where the lid sits in model space is unchanged, and the parts themselves are untouched.
    root.getObjectByName('model')!.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(lid);
    expect(box3.min.toArray()).toEqual([0, 0, 30]);
    expect(box3.max.toArray()).toEqual([60, 40, 40]);
    expect(input[0].positions[2]).toBe(30);
  });

  it('turns the lid about its hinge when the node rotates', () => {
    const root = buildModelObject(parts(), 'mm');
    root.getObjectByName('model')!.rotation.set(0, 0, 0);
    const lid = root.getObjectByName('lid')!;
    lid.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(lid);
    // Opened backwards: the front edge swings up over the hinge line at y = 40.
    expect(box3.min.y).toBeCloseTo(40);
    expect(box3.max.z).toBeCloseTo(70);
  });

  it('keeps the hierarchy and pivot in the GLB', async () => {
    const loaded = await loadAsset('glb', await exportGlb(buildModelObject(parts(), 'mm')));
    const lid = loaded.getObjectByName('lid')!;
    expect(lid.parent?.name).toBe('body');
    // Metres, and Y-up: the hinge at model (0, 40, 30) mm is glTF (0, 0.03, -0.04) relative to the body.
    expect(lid.position.x).toBeCloseTo(0);
    expect(lid.position.y).toBeCloseTo(0.03);
    expect(lid.position.z).toBeCloseTo(-0.04);
    // No scale or axis turn left on any node: the units and Y-up live in the vertices.
    loaded.traverse(node => {
      if (node === loaded) return;
      expect(node.scale.toArray().map(value => Number(value.toFixed(6)))).toEqual([1, 1, 1]);
      expect(Math.abs(node.quaternion.w)).toBeCloseTo(1);
    });
  });

  it('writes nodes as TRS with exact unit scale, as glTF requires for animated nodes', async () => {
    const bytes = await exportGlb(buildModelObject(parts(), 'mm'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as {
      nodes: { name?: string; matrix?: number[]; translation?: number[]; scale?: number[] }[];
    };
    expect(json.nodes.filter(node => node.matrix)).toEqual([]);
    expect(json.nodes.filter(node => node.scale)).toEqual([]);
    const lid = json.nodes.find(node => node.name === 'lid')!;
    expect(lid.translation?.map(value => Number(value.toFixed(6)))).toEqual([0, 0.03, -0.04]);
  });

  describe('as a joint', () => {
    // The lid turns about its hinge line (model X); negative X tips its front edge up and back.
    const jointed = () =>
      parts().map(part =>
        part.name === 'lid'
          ? { ...part, axis: [-1, 0, 0] as [number, number, number], range: [0, 90] as [number, number] }
          : part
      );

    it('poses the lid open about its hinge and back to rest', () => {
      const root = buildModelObject(jointed(), 'mm');
      root.getObjectByName('model')!.rotation.set(0, 0, 0);
      poseJoints(root, { lid: 90 });
      root.updateMatrixWorld(true);
      const open = new THREE.Box3().setFromObject(root.getObjectByName('lid')!);
      // Standing up behind the hinge: 40 deep becomes 40 tall, from the top of the body.
      expect(open.min.z).toBeCloseTo(30);
      expect(open.max.z).toBeCloseTo(70);
      expect(open.min.y).toBeCloseTo(40);
      expect(open.max.y).toBeCloseTo(50);
      poseJoints(root, {});
      root.updateMatrixWorld(true);
      expect(new THREE.Box3().setFromObject(root.getObjectByName('lid')!).max.z).toBeCloseTo(40);
    });

    it('names the open pose after each range end', () => {
      expect(openPose(buildModelObject(jointed(), 'mm'))).toEqual({ lid: 90 });
    });

    it('keeps the clips when the GLB is opened as an asset', async () => {
      const loaded = await loadAsset('glb', await exportGlb(buildModelObject(jointed(), 'mm')));
      expect(loaded.animations.map(clip => clip.name)).toEqual(['lid']);
      expect(loaded.clone(true).animations).toHaveLength(1);
    });

    it('exports at rest even when posed, with a clip per joint that opens it', async () => {
      const root = buildModelObject(jointed(), 'mm');
      poseJoints(root, { lid: 60 });
      const bytes = await exportGlb(root);
      const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
      const lid = loaded.scene.getObjectByName('lid')!;
      expect(lid.quaternion.w).toBeCloseTo(1);
      expect(loaded.animations.map(clip => clip.name)).toEqual(['lid']);
      const [clip] = loaded.animations;
      expect(clip.duration).toBeCloseTo(1);
      // Play it to the end on the loaded scene: the lid stands up, in glTF's Y-up metres.
      const mixer = new THREE.AnimationMixer(loaded.scene);
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = true;
      action.setLoop(THREE.LoopOnce, 1).play();
      mixer.update(1);
      loaded.scene.updateMatrixWorld(true);
      const open = new THREE.Box3().setFromObject(lid);
      expect(open.max.y).toBeCloseTo(0.07);
      expect(open.min.y).toBeCloseTo(0.03);
    });
  });

  describe('as a slide', () => {
    // A drawer under the body that pulls out toward the front (model -Y); no pivot needed.
    const slid = (): ModelPartMesh[] => [
      box('body', 60, 40, 30),
      {
        ...box('drawer', 50, 40, 10),
        parent: 'body',
        motion: 'slide',
        axis: [0, -2, 0],
        range: [0, 30],
      },
    ];

    it('poses the drawer along its axis by model units and back to rest', () => {
      const root = buildModelObject(slid(), 'mm');
      root.getObjectByName('model')!.rotation.set(0, 0, 0);
      poseJoints(root, { drawer: 30 });
      root.updateMatrixWorld(true);
      const open = new THREE.Box3().setFromObject(root.getObjectByName('drawer')!);
      // The axis is normalized: 30 units along it is 30 mm, however long the axis was written.
      expect(open.min.y).toBeCloseTo(-30);
      expect(open.max.y).toBeCloseTo(10);
      poseJoints(root, {});
      root.updateMatrixWorld(true);
      expect(new THREE.Box3().setFromObject(root.getObjectByName('drawer')!).min.y).toBeCloseTo(0);
    });

    it('exports at rest with a position clip that pulls it out, in metres and Y-up', async () => {
      const root = buildModelObject(slid(), 'mm');
      poseJoints(root, { drawer: 20 });
      const loaded = await new GLTFLoader().parseAsync((await exportGlb(root)).slice().buffer, '');
      const drawer = loaded.scene.getObjectByName('drawer')!;
      loaded.scene.updateMatrixWorld(true);
      // Model y 0..40 is glTF z 0..-0.04 at rest.
      expect(new THREE.Box3().setFromObject(drawer).max.z).toBeCloseTo(0);
      expect(loaded.animations.map(clip => clip.name)).toEqual(['drawer']);
      const mixer = new THREE.AnimationMixer(loaded.scene);
      const action = mixer.clipAction(loaded.animations[0]);
      action.clampWhenFinished = true;
      action.setLoop(THREE.LoopOnce, 1).play();
      mixer.update(1);
      loaded.scene.updateMatrixWorld(true);
      const open = new THREE.Box3().setFromObject(drawer);
      expect(open.max.z).toBeCloseTo(0.03);
      expect(open.min.z).toBeCloseTo(-0.01);
    });
  });

  it('reports joints in the summary', () => {
    expect(summarizeParts(parts(), {}, 'mm').joints).toEqual(['lid: pivot (0, 40, 30), in body']);
  });
});

describe('explodeModel', () => {
  /** A body 0..60 x 0..40 x 0..30, a lid on top hinged at its back edge, a band round the body and feet under it. */
  const parts = (): ModelPartMesh[] => {
    const lid = box('lid', 60, 40, 10);
    for (let index = 2; index < lid.positions.length; index += 3) lid.positions[index] += 30;
    const band = box('band', 70, 50, 34);
    for (let index = 0; index < band.positions.length; index += 3) {
      band.positions[index] -= 5;
      band.positions[index + 1] -= 5;
      band.positions[index + 2] -= 2;
    }
    const feet = box('feet', 60, 40, 4);
    for (let index = 2; index < feet.positions.length; index += 3) feet.positions[index] -= 4;
    return [
      box('body', 60, 40, 30),
      { ...lid, pivot: [0, 40, 30], parent: 'body', axis: [1, 0, 0], range: [0, 100] },
      { ...band, parent: 'body' },
      feet,
    ];
  };
  const placed = (root: THREE.Object3D, name: string) => {
    root.getObjectByName('model')!.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(root.getObjectByName(name)!);
  };

  it('lifts a lid off its box, keeps a band on it, and never sinks a part through the floor', () => {
    const root = buildModelObject(parts(), 'mm');
    expect(canExplode(root)).toBe(true);
    const lidBefore = placed(root, 'lid').min.z;
    const bandBefore = placed(root, 'band').min.toArray();
    const bodyBefore = placed(root, 'body').min.toArray();
    explodeModel(root, 1);
    const lidAfter = placed(root, 'lid').min.z;
    expect(lidAfter).toBeGreaterThan(lidBefore + 10);
    // The band moves only with the body it wraps.
    const bodyShift = placed(root, 'body')
      .min.clone()
      .sub(new THREE.Vector3(...bodyBefore));
    expect(
      placed(root, 'band')
        .min.clone()
        .sub(new THREE.Vector3(...bandBefore))
        .toArray()
    ).toEqual(bodyShift.toArray());
    expect(placed(root, 'feet').min.z).toBeGreaterThanOrEqual(-4);
    explodeModel(root, 0);
    expect(placed(root, 'lid').min.z).toBeCloseTo(lidBefore);
  });

  it('keeps a joint where it was posed, in either order', () => {
    const root = buildModelObject(parts(), 'mm');
    poseJoints(root, { lid: 90 });
    explodeModel(root, 1);
    const lid = root.getObjectByName('lid')!;
    expect(lid.rotation.x).toBeCloseTo(Math.PI / 2);
    explodeModel(root, 0);
    expect(lid.position.toArray()).toEqual([0, 40, 30]);
  });

  it('has nothing to pull apart in a single part', () => {
    expect(canExplode(buildModelObject([box('solo', 10, 10, 10)], 'mm'))).toBe(false);
  });
});

describe('drivingJoint / jointDragFrame', () => {
  /** A body, a lid hinged on it, a fixed handle on the lid and a flap hinged on the lid about model Z. */
  const assembly = () => {
    const root = buildModelObject(
      [
        box('body', 60, 40, 30),
        { ...box('lid', 60, 40, 10), pivot: [0, 40, 30], parent: 'body', axis: [-1, 0, 0], range: [0, 90] },
        { ...box('handle', 10, 4, 4), parent: 'lid' },
        { ...box('flap', 10, 10, 2), pivot: [30, 0, 40], parent: 'lid', axis: [0, 0, 1], range: [0, 45] },
      ],
      'mm'
    );
    // Model space as world space, so the expected axes read in model terms.
    root.getObjectByName('model')!.rotation.set(0, 0, 0);
    return root;
  };

  it('refuses a drag frame for a part that is not a joint', () => {
    expect(() => jointDragFrame(assembly().getObjectByName('body')!)).toThrow(/is not a joint/);
  });

  it('finds the part itself, its jointed parent, or nothing', () => {
    const root = assembly();
    expect(drivingJoint(root.getObjectByName('lid')!)?.name).toBe('lid');
    expect(drivingJoint(root.getObjectByName('handle')!)?.name).toBe('lid');
    expect(drivingJoint(root.getObjectByName('flap')!)?.name).toBe('flap');
    expect(drivingJoint(root.getObjectByName('body')!)).toBeNull();
  });

  it('reads the hinge at its pivot, along its axis', () => {
    const frame = jointDragFrame(assembly().getObjectByName('lid')!);
    expect(frame.motion).toBe('turn');
    expect(frame.pivot.toArray()).toEqual([0, 40, 30]);
    expect(frame.axis.toArray()).toEqual([-1, 0, 0]);
    expect(frame.range).toEqual([0, 90]);
    expect(frame.scale).toBeCloseTo(1, 10);
  });

  it("carries a child's axis round with its posed parent", () => {
    const root = assembly();
    poseJoints(root, { lid: 90 });
    const { axis } = jointDragFrame(root.getObjectByName('flap')!);
    // A quarter turn about -X takes model Z to model Y.
    expect(axis.x).toBeCloseTo(0, 6);
    expect(axis.y).toBeCloseTo(1, 6);
    expect(axis.z).toBeCloseTo(0, 6);
  });
});
