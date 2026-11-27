import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneSkin } from '@shared/mods';
import { AQUARIUM_SCENE } from '../aquarium/aquariumScene';
import { OFFICE_SCENE } from '../office/officeScene';
import { sampleSkinSummary } from '../sampleSkin';
import { TAVERN_SCENE } from '../tavern/tavernScene';
import { sceneDefinitionSchema } from './sceneDefinition';
import { skinScene } from './sceneSkin';
import { TEST_SCENE } from './testScene';

const sample = sampleSkinSummary();
const blockOf = (id: string): SceneSkin => {
  const block = sample.tokens.scenes?.[id];
  if (!block) throw new Error(`the sample skin has no ${id} block`);
  return block;
};

describe('skinScene', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('is the scene itself when the skin has no block for it', () => {
    expect(skinScene(TAVERN_SCENE, undefined, 'nightglass')).toBe(TAVERN_SCENE);
  });

  it.each([
    ['tavern', TAVERN_SCENE],
    ['office', OFFICE_SCENE],
    ['aquarium', AQUARIUM_SCENE],
  ] as const)('restyles the %s with the sample skin, and the result is a valid scene', (id, scene) => {
    const skinned = skinScene(scene, blockOf(id), 'nightglass');

    expect(skinned).not.toBe(scene);
    expect(sceneDefinitionSchema.safeParse(skinned).success).toBe(true);
    expect(skinned.map.backdrop).toMatch(/^b4m-skin:\/\/nightglass\/sprites\/.+\.png$/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('moves slots and anchors, replaces lights and merges copy, keeping everything else', () => {
    const skinned = skinScene(TAVERN_SCENE, blockOf('tavern'), 'nightglass');

    expect(skinned.map.zones.hearth.slots[0]).toEqual({ x: 72, y: 55 });
    expect(skinned.map.zones.hearth.overflow).toEqual(TAVERN_SCENE.map.zones.hearth.overflow);
    expect(skinned.map.zones.hearth.place).toBe('by the cold hearth');
    expect(skinned.map.zones.bar).toEqual(TAVERN_SCENE.map.zones.bar);
    expect(skinned.map.host).toEqual({ x: 70, y: 30.5 });
    expect(skinned.map.lights).toHaveLength(3);
    expect(skinned.map.occluders).toEqual(TAVERN_SCENE.map.occluders);
    expect(skinned.cast.host.sprites.idle).toBe('b4m-skin://nightglass/sprites/tavern-host-idle.png');
    expect(skinned.cast.host.sprites.cheering).toBe(TAVERN_SCENE.cast.host.sprites.cheering);
    expect(skinned.cast.sheets).toEqual(TAVERN_SCENE.cast.sheets);
    expect(skinned.copy.hostName).toBe('Barkeep');
    expect(skinned.copy.hostTitle).toBe(TAVERN_SCENE.copy.hostTitle);
    expect(skinned.copy.stage.finale).toEqual({ complete: "Night's work done", ended: 'Quest ended' });
    expect(skinned.states).toEqual(TAVERN_SCENE.states);
  });

  it("replaces the Office's cast sheets and merges a partial board", () => {
    const skinned = skinScene(OFFICE_SCENE, blockOf('office'), 'nightglass');

    expect(skinned.cast.sheets).toHaveLength(1);
    expect(skinned.cast.sheets[0].sprites.work).toBe('b4m-skin://nightglass/sprites/office-night-work.png');
    expect(skinned.map.board).toEqual({ ...OFFICE_SCENE.map.board, left: 60, top: 9 });
    expect(skinned.map.zones.reception.slots).toHaveLength(4);
  });

  it("takes the skin's reply anchor whole rather than mixing a left side with a right one", () => {
    const skinned = skinScene(TEST_SCENE, { map: { reply: { top: 10, left: 20 } } }, 'x');
    expect(skinned.map.reply).toEqual({ top: 10, left: 20 });
  });

  it('merges once per scene and block, so a re-render gets the same object', () => {
    const block: SceneSkin = { copy: { hostName: 'Once' } };
    const first = skinScene(TEST_SCENE, block, 'x');
    expect(skinScene(TEST_SCENE, block, 'x')).toBe(first);
    expect(skinScene(TEST_SCENE, { copy: { hostName: 'Once' } }, 'x')).not.toBe(first);
  });

  it.each<[string, SceneSkin]>([
    [
      'a sheet missing a pose',
      { cast: { sheets: [{ look: 'half', sprites: { busy: 'b4m-skin://x/sprites/a.png' } }] } },
    ],
    ['a zone the scene does not have, with no slots', { map: { zones: { attic: { place: 'in the attic' } } } }],
    ['a light of a kind the framework cannot draw', { map: { lights: [{ x: 1, y: 1, size: 4, kind: 'neon' }] } }],
  ])('falls back to the scene as it ships for %s, and says why once', (_label, block) => {
    const first = skinScene(TEST_SCENE, block, 'broken-skin');
    const again = skinScene(TEST_SCENE, block, 'broken-skin');

    expect(first).toBe(TEST_SCENE);
    expect(again).toBe(TEST_SCENE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/SKINS: broken-skin: ignoring its test-yard scene/);
  });
});
