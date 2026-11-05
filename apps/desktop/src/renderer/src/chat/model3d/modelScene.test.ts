// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelPartMesh } from '@shared/model3d';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  buildModelObject,
  exportGlb,
  loadAsset,
  openPose,
  partsToStl,
  poseJoints,
  summarizeObject,
  summarizeParts,
} from './modelScene';

/** An axis-aligned box from 0 to (x, y, z): 8 corners, 12 triangles, wound outward. */
function box(name: string, x: number, y: number, z: number): ModelPartMesh {
  const positions = new Float32Array([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { name, color: '#8b5a2b', positions, indices };
}

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
