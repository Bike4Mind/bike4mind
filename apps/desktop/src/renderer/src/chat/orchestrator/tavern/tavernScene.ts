import type { SceneDefinition } from '../scene/sceneDefinition';
import { INNKEEPER_ART, TAVERN_BACKDROP, TAVERN_CAST } from './tavernArt';
import { TAVERN_LAYOUT } from './tavernLayout';

const { slots, overflow } = TAVERN_LAYOUT;

/**
 * The Tavern as a scene definition: the map from assets/orchestrator/tavern/layout.json, the cast and the
 * Innkeeper from their sheets, and the Tavern's words and wood. tavernScene.test.ts holds it to
 * sceneDefinitionSchema, so a bad layout fails CI rather than the chat screen.
 */
export const TAVERN_SCENE: SceneDefinition = {
  version: 1,
  id: 'tavern',
  map: {
    aspect: { width: 16, height: 9 },
    backdrop: TAVERN_BACKDROP,
    zones: {
      workbench: { slots: slots.workbench, overflow: overflow.workbench, place: 'at the workbenches' },
      bar: { slots: slots.bar, overflow: overflow.bar, place: 'at the bar' },
      hearth: { slots: slots.hearth, overflow: overflow.hearth, place: 'by the hearth' },
      benches: { slots: slots.benches, overflow: overflow.benches, place: 'on the benches' },
    },
    // The benches face the bar; the hearth is furthest from it.
    borrowOrder: ['benches', 'workbench', 'hearth'],
    door: TAVERN_LAYOUT.door,
    board: TAVERN_LAYOUT.questBoard,
    // Behind the bar counter, above the stools, so the Innkeeper never takes an agent's seat.
    host: TAVERN_LAYOUT.innkeeper,
    // Ends just left of the Innkeeper, its tail pointing at him.
    reply: { top: 3, right: 42 },
    occluders: [TAVERN_LAYOUT.barCounter],
    lights: TAVERN_LAYOUT.lights,
    moon: TAVERN_LAYOUT.window,
    embers: TAVERN_LAYOUT.hearthGlow,
  },
  cast: {
    spriteHeight: 15,
    poses: ['work', 'call', 'rest', 'ko', 'idle'],
    animatedPoses: ['work'],
    sheets: TAVERN_CAST.map(({ look, craft, sprites }) => ({ look, craft, sprites })),
    host: { sprites: INNKEEPER_ART },
  },
  states: {
    zone: {
      working: 'workbench',
      // Still on the job: its background command will wake it.
      waiting: 'workbench',
      'needs-you': 'bar',
      done: 'hearth',
      failed: 'benches',
      paused: 'benches',
      stopped: 'benches',
      idle: 'benches',
    },
    pose: {
      working: 'work',
      waiting: 'idle',
      'needs-you': 'call',
      done: 'rest',
      failed: 'ko',
      paused: 'idle',
      stopped: 'idle',
      idle: 'idle',
    },
  },
  ambience: {
    frame: '#0b0603',
    floor: '#140c06',
    settledDrift: true,
    settledShadow: '0 0 80px 30px rgba(8, 4, 2, 0.85)',
  },
  look: {
    // Wood: a lit top edge and a dark bottom one, notched corners in the pixel-art way (no radius).
    plate: {
      background: 'linear-gradient(#6b4523, #4a2e14)',
      edge: 'inset 0 1px 0 rgba(255, 214, 150, 0.35), 0 -1px 0 #1f1208, 0 1px 0 #1f1208, -1px 0 0 #1f1208, 1px 0 0 #1f1208, 0 2px 0 rgba(0, 0, 0, 0.45)',
      ink: '#fbe9c8',
    },
    finale: 'tavern',
  },
  copy: {
    name: 'Tavern',
    hostName: 'Innkeeper',
    hostTitle: 'the conversation that posts the quests',
    hostGreeting: "What'll it be?",
    hostPoses: {
      idle: 'Polishing the bar',
      writing: 'Posting quests',
      reading: 'Reading the reports',
      walking: 'Checking on an agent',
      cheering: 'Cheering',
    },
    board: { title: 'Quests', name: 'Quest board', item: 'quest', items: 'quests', empty: 'No quests posted' },
    stage: {
      host: 'The Innkeeper',
      quiet: 'The tavern is quiet',
      talk: 'Type to talk to the Innkeeper',
      empty: 'No quests yet. Describe the work and the Innkeeper will split it across agents.',
      emptyArchived:
        'Every quest is done and its agent archived. Describe more work and the Innkeeper will hand it out.',
      finale: { complete: 'Quest complete', ended: 'Quest ended' },
    },
  },
};
