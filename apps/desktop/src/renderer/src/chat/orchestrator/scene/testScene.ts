import { parseSceneDefinition, type SceneDefinition } from './sceneDefinition';

const swatch = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="4" y="2" width="8" height="14" fill="${fill}"/></svg>`
  )}`;

const sheet = (look: string, fill: string, craft?: 'Scribe' | 'Tinkerer') => ({
  look,
  ...(craft && { craft }),
  sprites: { busy: swatch(fill), ask: swatch(fill), rest: swatch(fill) },
});

const row = (y: number, from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ x: from + index * 8, y }));

/**
 * A small scene with plain swatch sprites, for tests of the framework itself. It is not registered as a
 * view: it exists to prove that data alone draws a working scene.
 */
export const TEST_SCENE: SceneDefinition = parseSceneDefinition({
  version: 1,
  id: 'test-yard',
  map: {
    aspect: { width: 16, height: 9 },
    backdrop: swatch('#2b3a2f'),
    zones: {
      desk: { slots: row(45, 10, 3), overflow: { x: 40, y: 45 }, place: 'at the desks' },
      porch: { slots: row(70, 55, 2), overflow: { x: 80, y: 70 }, place: 'on the porch' },
      yard: { slots: row(90, 10, 4), overflow: { x: 50, y: 90 }, place: 'in the yard' },
    },
    borrowOrder: ['yard', 'desk'],
    door: { x: 95, y: 90 },
    board: { left: 70, top: 5, width: 20, height: 25, notes: 3 },
    host: { x: 50, y: 30 },
    reply: { top: 3, right: 55 },
    occluders: [{ left: 40, right: 60, top: 26, front: 34 }],
    lights: [{ x: 20, y: 20, size: 8, kind: 'candle' }],
    moon: { x: 30, y: 10 },
  },
  cast: {
    spriteHeight: 15,
    poses: ['busy', 'ask', 'rest'],
    animatedPoses: ['busy'],
    sheets: [sheet('green', '#4caf50', 'Tinkerer'), sheet('blue', '#42a5f5', 'Scribe'), sheet('grey', '#9e9e9e')],
    host: {
      sprites: {
        idle: swatch('#795548'),
        writing: swatch('#795548'),
        reading: swatch('#795548'),
        walking: swatch('#795548'),
        cheering: swatch('#ffeb3b'),
      },
    },
  },
  states: {
    zone: {
      'needs-you': 'porch',
      working: 'desk',
      waiting: 'desk',
      done: 'yard',
      failed: 'yard',
      paused: 'yard',
      stopped: 'yard',
      idle: 'yard',
    },
    pose: {
      'needs-you': 'ask',
      working: 'busy',
      waiting: 'rest',
      done: 'rest',
      failed: 'rest',
      paused: 'rest',
      stopped: 'rest',
      idle: 'rest',
    },
  },
  ambience: { frame: '#0b0603', floor: '#1b241d', settledDrift: true, settledShadow: 'none' },
  look: {
    plate: { background: '#33402f', edge: 'none', ink: '#f1f5e8' },
    finale: 'office',
  },
  copy: {
    name: 'Test yard',
    hostName: 'Warden',
    hostTitle: 'the conversation that posts the work',
    hostGreeting: 'Anything for me?',
    hostPoses: {
      idle: 'Watching the yard',
      writing: 'Posting jobs',
      reading: 'Reading reports',
      walking: 'Checking on someone',
      cheering: 'Cheering',
    },
    board: { title: 'Jobs', name: 'Job board', item: 'job', items: 'jobs', empty: 'No jobs posted' },
    stage: {
      host: 'The Warden',
      quiet: 'The yard is quiet',
      talk: 'Type to talk to the Warden',
      empty: 'No jobs yet. Describe the work and the Warden will split it across agents.',
      emptyArchived: 'Every job is done and its agent archived. Describe more work and the Warden will hand it out.',
      finale: { complete: 'Jobs complete', ended: 'Jobs ended' },
    },
  },
});
