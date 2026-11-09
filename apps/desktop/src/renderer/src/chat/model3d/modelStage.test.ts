// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addGlowLights, MAX_GLOW_LIGHTS, toneMapped, untoneMapped } from './modelStage';

describe('untoneMapped', () => {
  it.each(['#f4f5f7', '#1b1e23', '#808080'])('comes back out of the tone mapping as %s', hex => {
    const shown = toneMapped(untoneMapped(hex));
    expect(`#${shown.getHexString(THREE.SRGBColorSpace)}`).toBe(hex);
  });

  it('needs a brighter-than-white input for a near-white backdrop, which a plain hex cannot give', () => {
    expect(untoneMapped('#f4f5f7').r).toBeGreaterThan(1);
  });
});

describe('addGlowLights', () => {
  const part = (name: string, emissive: number, emissiveIntensity: number) => {
    const material = new THREE.MeshPhysicalMaterial();
    material.userData = { emissive, emissiveIntensity };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(5, 0, 0), material);
    mesh.name = name;
    return mesh;
  };

  it('puts a light at the heart of each glowing part, the brightest casting shadows', () => {
    const root = new THREE.Group();
    root.add(part('ember', 0xff4000, 1), part('gem', 0xffffff, 4), part('box', 0, 0));
    const lights = addGlowLights(root, 10);
    expect(lights.map(light => light.parent?.name)).toEqual(['gem', 'ember']);
    expect(lights[0].castShadow).toBe(true);
    expect(lights[1].castShadow).toBe(false);
    expect(lights[0].position.toArray()).toEqual([5, 0, 0]);
  });

  it('scales the light to the model, so mm and m models are lit alike', () => {
    const small = addGlowLights(part('gem', 0xffffff, 1), 1)[0];
    const large = addGlowLights(part('gem', 0xffffff, 1), 1000)[0];
    expect(large.intensity / small.intensity).toBeCloseTo(1e6);
    expect(large.distance / small.distance).toBeCloseTo(1000);
  });

  it('stops a glowing part casting the shadow of its own light', () => {
    const gem = part('gem', 0xffffff, 1);
    gem.castShadow = true;
    addGlowLights(gem, 1);
    expect(gem.castShadow).toBe(false);
  });

  it(`lights at most ${MAX_GLOW_LIGHTS} parts`, () => {
    const root = new THREE.Group();
    for (let index = 0; index < MAX_GLOW_LIGHTS + 3; index += 1) root.add(part(`p${index}`, 0xffffff, 1));
    expect(addGlowLights(root, 1)).toHaveLength(MAX_GLOW_LIGHTS);
  });
});
