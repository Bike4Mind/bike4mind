import type { SceneDefinition } from '../scene/sceneDefinition';
import { MANAGER_ART, OFFICE_BACKDROP, OFFICE_CAST } from './officeArt';

// The backdrop is drawn on a 1000x640 grid (scripts/orchestrator-art/office/backdrop.svg); every point
// below is picked on that grid and turned into the percent of the scene box the framework reads.
const at = (x: number, y: number) => ({ x: x / 10, y: (y * 100) / 640 });
const row = (y: number, ...xs: number[]) => xs.map(x => at(x, y));

/**
 * The Office as a scene definition: the Paper company floor plan, its staff and the Manager, and the
 * Office's words and greens. officeScene.test.ts holds it to sceneDefinitionSchema.
 */
export const OFFICE_SCENE: SceneDefinition = {
  version: 1,
  id: 'office',
  map: {
    aspect: { width: 1000, height: 640 },
    backdrop: OFFICE_BACKDROP,
    zones: {
      // At the chairs below each desk, the main floor first and then the annex by the conference room.
      desks: {
        slots: [
          ...row(396, 287, 440),
          ...row(470, 287, 440),
          ...row(485, 801, 906),
          ...row(596, 282, 442),
          ...row(598, 801, 906),
        ],
        overflow: at(515, 430),
        place: 'at the desks',
      },
      // The corridor along the glass, outside the Manager's door. It fills from the right so a waiting
      // agent's answer bubble, which hangs over the first seats, never covers the Manager.
      'manager-door': { slots: row(298, 310, 370, 250, 190, 130, 70), overflow: at(430, 298), place: 'by the door' },
      conference: {
        slots: [...row(228, 318, 363, 408, 453), ...row(120, 318, 363, 408, 453)],
        overflow: at(262, 230),
        place: 'in the conference room',
      },
      break: {
        slots: [at(585, 186), at(893, 202), ...row(246, 620, 685, 820, 885), ...row(330, 620, 685, 820)],
        overflow: at(750, 290),
        place: 'in the break room',
      },
      reception: {
        slots: [at(180, 386), at(100, 462), at(70, 590), at(150, 590)],
        overflow: at(212, 500),
        place: 'in reception',
      },
    },
    // Out of the corridor, the conference room is nearest the Manager; the break room is furthest.
    borrowOrder: ['conference', 'desks', 'break'],
    door: at(35, 520),
    // A bulletin board on the break room's back wall, between the coffee maker and the vending machines.
    board: { left: 65, top: 7, width: 12, height: 19, notes: 3 },
    // In the Manager's office, in front of the desk.
    host: at(113, 234),
    // Hangs to the Manager's right, its tail pointing back at the Manager.
    reply: { top: 21, left: 15 },
    occluders: [],
    lights: [
      { ...at(113, 160), size: 6, kind: 'lamp' },
      { ...at(287, 330), size: 6, kind: 'lamp' },
      { ...at(440, 330), size: 6, kind: 'lamp' },
      { ...at(287, 450), size: 6, kind: 'lamp' },
      { ...at(440, 450), size: 6, kind: 'lamp' },
      { ...at(282, 545), size: 6, kind: 'lamp' },
      { ...at(442, 545), size: 6, kind: 'lamp' },
      { ...at(801, 420), size: 6, kind: 'lamp' },
      { ...at(906, 420), size: 6, kind: 'lamp' },
      { ...at(801, 555), size: 6, kind: 'lamp' },
      { ...at(906, 555), size: 6, kind: 'lamp' },
      { ...at(69, 316), size: 5, kind: 'lamp' },
      { ...at(585, 125), size: 5, kind: 'lamp' },
      { ...at(894, 140), size: 7, kind: 'lamp' },
    ],
    moon: at(396, 68),
  },
  cast: {
    spriteHeight: 9,
    poses: ['work', 'call', 'rest', 'idle'],
    animatedPoses: ['work'],
    sheets: OFFICE_CAST.map(({ look, craft, sprites }) => ({ look, craft, sprites })),
    host: { sprites: MANAGER_ART },
  },
  states: {
    zone: {
      working: 'desks',
      waiting: 'desks',
      'needs-you': 'manager-door',
      done: 'break',
      failed: 'conference',
      paused: 'conference',
      stopped: 'conference',
      idle: 'conference',
    },
    pose: {
      working: 'work',
      waiting: 'idle',
      'needs-you': 'call',
      done: 'rest',
      failed: 'idle',
      paused: 'idle',
      stopped: 'idle',
      idle: 'idle',
    },
    preparing: 'reception',
  },
  ambience: {
    frame: '#141d1c',
    floor: '#202e2c',
    settledDrift: true,
    settledShadow: '0 0 80px 30px rgba(10, 16, 15, 0.85)',
  },
  look: {
    // The Office's dark green signage, notched like the rest of its pixel art.
    plate: {
      background: 'linear-gradient(#34493c, #27382d)',
      edge: 'inset 0 1px 0 rgba(244, 237, 205, 0.25), 0 -1px 0 #141d1c, 0 1px 0 #141d1c, -1px 0 0 #141d1c, 1px 0 0 #141d1c, 0 2px 0 rgba(0, 0, 0, 0.45)',
      ink: '#f4edcd',
    },
    finale: 'office',
  },
  copy: {
    name: 'Office',
    hostName: 'Manager',
    hostTitle: 'the conversation that hands out the work',
    hostGreeting: 'What are we working on?',
    hostPoses: {
      idle: 'At the desk',
      writing: 'Writing up assignments',
      reading: 'Reading the reports',
      walking: 'Checking on an employee',
      cheering: 'Cheering',
    },
    board: { title: 'Tasks', name: 'Bulletin board', item: 'task', items: 'tasks', empty: 'No tasks posted' },
    stage: {
      host: 'The Manager',
      quiet: 'The office is quiet',
      talk: 'Type to talk to the Manager',
      empty: 'No tasks yet. Describe the work and the Manager will split it across the team.',
      emptyArchived: 'Every task is done and its agent archived. Describe more work and the Manager will hand it out.',
      finale: { complete: 'Shift complete', ended: 'Shift ended' },
    },
  },
};
