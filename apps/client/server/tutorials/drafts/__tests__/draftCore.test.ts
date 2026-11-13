// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BRIDGE_STEP_ID, type TutorialDraftContent, type TutorialStep, type TutorialTurn } from '@bike4mind/common';

vi.mock('../../registry', () => ({
  CORE_TUTORIALS: [{ id: 'shipped', title: 'Shipped', visibility: { public: true }, enabled: true }],
  resolveCoreTutorial: (id: string) => (id === 'shipped' ? { id } : null),
}));
vi.mock('../../content', () => ({ CORE_TUTORIAL_CONTENT: [] }));
vi.mock('../../models', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tutorialModels: () => ({ Progress: {}, Override: {}, OverrideChange: {}, Draft: {} }),
}));

import { createDraftCore, type DraftProfile } from '../draftCore';
import { validateTutorialModule, type KnownSelectors } from '../../validate';
import { CORE_DRAFT_PROFILE, coreDraftCore } from '../../coreDrafts';

const transcript: TutorialTurn[] = [
  { prompt: 'Plan my week', reply: 'Here is a plan.' },
  { prompt: 'Use my sheet', reply: 'Done with the sheet.', attachSheet: true },
  { prompt: 'Now race it', reply: 'Raced.' },
];
const sheet = { name: 'week.csv', csv: 'day,hours\nmon,8\n' };

describe('under the core profile', () => {
  const core = coreDraftCore;
  const content = (patch: Partial<TutorialDraftContent> = {}): TutorialDraftContent => {
    const base: TutorialDraftContent = {
      moduleId: 'my-week',
      title: 'Plan the week',
      pitch: 'Plan a week from a sheet.',
      transcript,
      sheet,
      steps: CORE_DRAFT_PROFILE.starterSteps(transcript),
      finale: CORE_DRAFT_PROFILE.defaultFinale,
      visibility: { entitlement: 'k' },
      ...patch,
    };
    return { ...base, steps: core.normalizeDraftSteps(base) };
  };
  const rulesOf = (c: TutorialDraftContent) => core.validateDraft(c).map(i => i.rule);

  it('starter steps validate once a reply is present, with no anchor-known issue', () => {
    expect(core.validateDraft(content())).toEqual([]);
  });

  it('breaks draft-visibility without a visibility', () => {
    expect(rulesOf(content({ visibility: undefined }))).toContain('draft-visibility');
  });

  it.each([{ public: true as const }, { entitlement: 'x' }])('accepts visibility %o', visibility => {
    expect(rulesOf(content({ visibility }))).not.toContain('draft-visibility');
  });

  it.each([{ entitlement: '' }, { public: false }, { entitlement: 'x', public: true }, null])(
    'refuses malformed visibility %o',
    visibility => {
      expect(rulesOf(content({ visibility: visibility as never }))).toContain('draft-visibility');
    }
  );

  it('fills the sent prompts and the sheet name an author never types', () => {
    const steps = content().steps;
    expect(steps.find(s => s.type === 'attach')?.params).toEqual({ fileName: 'week.csv' });
    expect(steps.find(s => s.id === 'turn-2')?.prompt).toBe('Now race it');
    expect(steps.find(s => s.type === 'attach')?.turn).toBeUndefined();
  });

  it('does not require a canvas node', () => {
    expect(rulesOf(content())).not.toContain('draft-canvas-node');
  });

  it('needs a sheet once a step attaches one', () => {
    expect(rulesOf(content({ sheet: undefined }))).toContain('draft-sheet');
  });

  it('refuses a shipped module id, a step type outside the core list and unknown anchors', () => {
    expect(rulesOf(content({ moduleId: 'shipped' }))).toContain('draft-id');
    const c = content();
    const extra = { id: 'run', type: 'canvasRace', body: 'x' } as TutorialStep;
    expect(rulesOf({ ...c, steps: [...c.steps, extra] })).toContain('draft-step');
    const wild = { id: 'wild', type: 'point', body: 'x', anchor: 'not-a-real-anchor' } as TutorialStep;
    expect(rulesOf({ ...c, steps: [...c.steps, wild] })).toContain('anchor-known');
  });

  it('serves the draft as a created module without a finale step', () => {
    const { door, module } = core.draftModule(content(), { revision: 5, enabled: true });
    expect(door).toMatchObject({ id: 'my-week', created: true, revision: 5, enabled: true });
    expect(door.steps.at(-1)?.id).toBe('turn-2');
    expect(module.sheet).toEqual(sheet);
    expect(module.openingPrompt).toBe('Plan my week');
  });
});

type TestCanvas = { turn: number; primary?: string };

describe('under a canvas test profile', () => {
  const BRIDGE: TutorialStep = { id: BRIDGE_STEP_ID, type: 'point', body: 'The end.' };
  const noParams = z.object({}).strict().optional();
  const known: KnownSelectors = {
    anchors: new Set(['attach-files-btn', 'canvas-drawer-race']),
    anchorScopes: new Set(),
    avoids: new Set(),
  };
  const canvasProfile: DraftProfile<TestCanvas> = {
    params: {
      prompt: noParams,
      point: noParams,
      attachSheet: z.object({ fileName: z.string().min(1) }).strict(),
      canvasRace: z
        .object({ nodeId: z.string().min(1), objective: z.number().finite({ message: 'set the proven best' }) })
        .strict(),
    },
    sendTypes: ['prompt', 'attachSheet'],
    attachType: 'attachSheet',
    starterSteps: t => [
      ...t.map((turn, i): TutorialStep =>
        turn.attachSheet
          ? { id: `turn-${i}`, type: 'attachSheet', turn: i, anchor: 'attach-files-btn', body: 'Attach.' }
          : { id: `turn-${i}`, type: 'prompt', turn: i, body: 'Send.' }
      ),
      { id: 'race', type: 'canvasRace', anchor: 'canvas-drawer-race', body: 'Race.' },
    ],
    defaultFinale: { title: 'Done', body: 'Done.' },
    isRepoModuleId: id => id === 'repo-owned',
    withFinale: steps => [...steps, BRIDGE],
    validateModule: module => validateTutorialModule(module, { known }),
    canvas: {
      normalizeStep: (step, nodeId, authored) =>
        step.type === 'canvasRace' ? { ...step, params: { nodeId, objective: authored.objective } } : null,
      fold: (canvas, nodeId) => (canvas.primary ? canvas : { ...canvas, primary: nodeId }),
    },
    requireVisibility: false,
  };
  const core = createDraftCore(canvasProfile);

  const captured = (patch: Partial<TutorialDraftContent<TestCanvas>> = {}) => {
    const base: TutorialDraftContent<TestCanvas> = {
      moduleId: 'my-sites',
      title: 'Pick the sites',
      pitch: 'Where to build next.',
      transcript,
      canvas: { turn: 1 },
      sheet,
      steps: canvasProfile.starterSteps(transcript),
      canvasNodeId: 'site-selection',
      finale: canvasProfile.defaultFinale,
      ...patch,
    };
    return { ...base, steps: core.normalizeDraftSteps(base) };
  };
  const withObjective = (c: ReturnType<typeof captured>, objective: number) => {
    const next = { ...c, steps: c.steps.map(s => (s.type === 'canvasRace' ? { ...s, params: { objective } } : s)) };
    return { ...next, steps: core.normalizeDraftSteps(next) };
  };
  const rulesOf = (c: ReturnType<typeof captured>) => core.validateDraft(c).map(i => i.rule);

  it('a fresh capture fails until the race has a proven best', () => {
    expect(rulesOf(captured())).toContain('draft-params');
    expect(core.validateDraft(withObjective(captured(), 1))).toEqual([]);
  });

  it('requires a canvas node, and no visibility', () => {
    const c = withObjective(captured({ canvasNodeId: undefined }), 1);
    expect(rulesOf(c)).toContain('draft-canvas-node');
    expect(rulesOf(withObjective(captured(), 1))).not.toContain('draft-visibility');
  });

  it('refuses a repo module id and a malformed id', () => {
    expect(rulesOf(withObjective(captured({ moduleId: 'repo-owned' }), 1))).toContain('draft-id');
    expect(rulesOf(withObjective(captured({ moduleId: 'Bad Id' }), 1))).toContain('draft-id');
  });

  it('refuses a step type outside the list, the finale step id and unknown step keys', () => {
    const c = withObjective(captured(), 1);
    const add = (step: unknown) => rulesOf({ ...c, steps: [...c.steps, step as TutorialStep] });
    expect(add({ id: 'run', type: 'recordedRun', body: 'Run it.' })).toContain('draft-step');
    expect(add({ id: BRIDGE_STEP_ID, type: 'point', body: 'x' })).toContain('draft-step');
    expect(add({ id: 'extra', type: 'point', body: 'x', script: 'y' })).toContain('draft-step');
  });

  it('holds the sheet rules: no sheet and a formula cell both fail', () => {
    const c = withObjective(captured(), 1);
    expect(core.validateDraft({ ...c, sheet: undefined }).length).toBeGreaterThan(0);
    expect(rulesOf({ ...c, sheet: { name: 'sites.csv', csv: 'a,b\n=HYPERLINK("x"),2\n' } })).toContain('sheet-formula');
  });

  it('fills sent prompts, the sheet name and the canvas node, and sends on the attach type', () => {
    const steps = captured().steps;
    expect(steps.find(s => s.type === 'attachSheet')).toMatchObject({
      params: { fileName: 'week.csv' },
      turn: 1,
      prompt: 'Use my sheet',
    });
    expect(steps.find(s => s.id === 'turn-0')?.prompt).toBe('Plan my week');
    expect(steps.find(s => s.type === 'canvasRace')?.params).toMatchObject({ nodeId: 'site-selection' });
  });

  it('appends the owner finale and folds the canvas onto the node', () => {
    const { door, module } = core.draftModule(withObjective(captured(), 1), { revision: 0, enabled: true });
    expect(door.steps.at(-1)?.id).toBe(BRIDGE_STEP_ID);
    expect(door.canvasSolve).toEqual({ nodeId: 'site-selection', turn: 1 });
    expect(module.canvas).toMatchObject({ primary: 'site-selection' });
  });
});
