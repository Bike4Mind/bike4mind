import type { SceneDefinition, ScenePoint } from '../scene/sceneDefinition';
import { AQUARIUM_BACKDROP, FISH_CAST, FISH_POSES, KEEPER_ART } from './aquariumArt';

const row = (y: number, xs: readonly number[]): ScenePoint[] => xs.map(x => ({ x, y }));

/**
 * The Aquarium as a scene definition: a quiet tank meant to sit on a second monitor. The bands match
 * backdrop.png (assets README): plants fill the outer sixth on each side, so every seat is in the open
 * water between them, and the sand bed is the bottom fifth. Working fish swim lengths of the midwater;
 * one that needs the user comes to the front glass; done ones rest low; the rest sleep on the sand.
 * aquariumScene.test.ts holds it to sceneDefinitionSchema.
 */
export const AQUARIUM_SCENE: SceneDefinition = {
  version: 1,
  id: 'aquarium',
  map: {
    aspect: { width: 16, height: 9 },
    backdrop: AQUARIUM_BACKDROP,
    zones: {
      // Lanes three deep, each swum `cast.roam.reach` either side of its seat. The middle row sits between
      // the others, so a swimmer's bubble rises into open water rather than onto the plate above it.
      midwater: {
        slots: [...row(33, [30, 50, 70]), ...row(44, [40, 60]), ...row(55, [30, 50, 70])],
        overflow: { x: 85, y: 45 },
        place: 'in the midwater',
      },
      glass: { slots: row(84, [30, 40, 50, 60, 70]), overflow: { x: 18, y: 84 }, place: 'at the glass' },
      low: { slots: row(71, [26, 34, 42, 50, 58, 66, 74]), overflow: { x: 16, y: 71 }, place: 'low in the tank' },
      sand: { slots: row(94, [21, 29, 37, 45, 53, 61, 69, 77]), overflow: { x: 86, y: 94 }, place: 'on the sand' },
    },
    borrowOrder: ['low', 'midwater', 'sand'],
    // Newcomers glide in from the left wall at midwater.
    door: { x: 2, y: 44 },
    // Hung over the left-hand plants, clear of the open water.
    board: { left: 3, top: 6, width: 14, height: 28, notes: 3 },
    // On top of the big right-hand rock, above every seat.
    host: { x: 92, y: 63 },
    // Ends just left of the Keeper, its tail at the Keeper's head.
    reply: { top: 46, right: 13 },
    occluders: [],
    // The hood lamps over the water.
    lights: [
      { x: 30, y: 3, size: 22, kind: 'lamp', tone: 'blue' },
      { x: 70, y: 3, size: 22, kind: 'lamp', tone: 'blue' },
    ],
  },
  cast: {
    spriteHeight: 12,
    poses: [...FISH_POSES],
    // The fish fill the lower half of their canvases.
    faceY: 70,
    animatedPoses: ['front'],
    roam: { poses: ['swim'], reach: 6 },
    sheets: FISH_CAST.map(({ look, hue, sprites }) => ({ look, hue, sprites })),
    host: { sprites: KEEPER_ART },
  },
  states: {
    zone: {
      working: 'midwater',
      waiting: 'midwater',
      'needs-you': 'glass',
      done: 'low',
      failed: 'sand',
      paused: 'sand',
      stopped: 'sand',
      idle: 'sand',
    },
    pose: {
      working: 'swim',
      waiting: 'rest',
      'needs-you': 'front',
      done: 'rest',
      failed: 'pale',
      paused: 'sleep',
      stopped: 'sleep',
      idle: 'sleep',
    },
  },
  ambience: {
    frame: '#05141a',
    floor: '#0e2a33',
    settledDrift: true,
    settledShadow: '0 0 80px 30px rgba(2, 10, 14, 0.85)',
    // Low contrast for a second monitor: a soft veil over the art, never over the fish.
    veil: 'rgba(8, 22, 30, 0.28)',
    awakeUnfocused: true,
  },
  look: {
    plate: {
      background: 'linear-gradient(#2f5a63, #1d3d44)',
      edge: 'inset 0 1px 0 rgba(190, 240, 235, 0.35), 0 -1px 0 #0a1a1e, 0 1px 0 #0a1a1e, -1px 0 0 #0a1a1e, 1px 0 0 #0a1a1e, 0 2px 0 rgba(0, 0, 0, 0.45)',
      ink: '#e6f6f4',
    },
    finale: 'tavern',
  },
  copy: {
    name: 'Aquarium',
    hostName: 'Keeper',
    hostTitle: 'the conversation that sets the fish their work',
    hostGreeting: 'Anything for the tank?',
    hostPoses: {
      idle: 'Watching the tank',
      writing: 'Writing up tasks',
      reading: 'Reading the reports',
      walking: 'Checking on a fish',
      cheering: 'Cheering',
    },
    board: { title: 'Tasks', name: 'Task slate', item: 'task', items: 'tasks', empty: 'No tasks posted' },
    stage: {
      host: 'The Keeper',
      quiet: 'The tank is quiet',
      talk: 'Type to talk to the Keeper',
      empty: 'No fish yet. Describe the work and the Keeper will split it across agents.',
      emptyArchived: 'Every task is done and its fish archived. Describe more work and the Keeper will hand it out.',
      finale: { complete: 'Tasks complete', ended: 'Tasks ended' },
    },
  },
};
