import { describe, expect, it } from 'vitest';
import { AGENT_STATE_LABEL } from '@shared/agentState';
import { parseSceneDefinition, sceneDefinitionSchema, type SceneDefinition } from './sceneDefinition';
import { TEST_SCENE } from './testScene';

const broken = (change: (scene: SceneDefinition) => void) => {
  const scene = structuredClone(TEST_SCENE);
  change(scene);
  return scene;
};

describe('sceneDefinitionSchema', () => {
  it('accepts the test scene', () => {
    expect(sceneDefinitionSchema.safeParse(TEST_SCENE).success).toBe(true);
  });

  it('maps every agent state to a zone and a pose', () => {
    const states = Object.keys(AGENT_STATE_LABEL).sort();
    expect(Object.keys(TEST_SCENE.states.zone).sort()).toEqual(states);
    expect(Object.keys(TEST_SCENE.states.pose).sort()).toEqual(states);
  });

  it.each([
    ['an unknown state zone', 'states.zone.working', broken(scene => (scene.states.zone.working = 'attic'))],
    ['an unknown state pose', 'states.pose.done', broken(scene => (scene.states.pose.done = 'dance'))],
    ['an unknown borrow zone', 'map.borrowOrder[0]', broken(scene => (scene.map.borrowOrder = ['attic']))],
    ['an unknown animated pose', 'cast.animatedPoses[0]', broken(scene => (scene.cast.animatedPoses = ['dance']))],
    [
      'an unknown roaming pose',
      'cast.roam.poses[0]',
      broken(scene => (scene.cast.roam = { poses: ['dance'], reach: 5 })),
    ],
    [
      'a sheet missing a pose',
      'cast.sheets[0].sprites.ask',
      broken(scene => delete (scene.cast.sheets[0].sprites as Record<string, string>).ask),
    ],
    ['a point off the map', 'map.door.x', broken(scene => (scene.map.door.x = 140))],
    ['an empty zone', 'map.zones.desk.slots', broken(scene => (scene.map.zones.desk.slots = []))],
    ['an unknown preparing zone', 'states.preparing', broken(scene => (scene.states.preparing = 'attic'))],
    ['a board of no size', 'map.board.width', broken(scene => (scene.map.board.width = 0))],
  ])('rejects %s, naming the field', (_, field, scene) => {
    expect(() => parseSceneDefinition(scene)).toThrow(field);
  });

  it('accepts a preparing zone and a reply bubble hung to the right of its host', () => {
    const scene = broken(scene => {
      scene.states.preparing = 'porch';
      scene.map.reply = { top: 10, left: 20 };
    });
    expect(parseSceneDefinition(scene)).toMatchObject({ states: { preparing: 'porch' }, map: { reply: { left: 20 } } });
  });

  it('rejects another contract version', () => {
    expect(() => parseSceneDefinition({ ...TEST_SCENE, version: 2 })).toThrow('version');
  });

  it('rejects a scene with no zones', () => {
    expect(() => parseSceneDefinition(broken(scene => (scene.map.zones = {})))).toThrow('at least one zone');
  });
});
