// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { TutorialStep } from '@bike4mind/common';
import { OVERRIDE_BUNDLE_FORMAT, type OverrideUnit } from '@bike4mind/common';
import {
  applyBundle,
  assertWritable,
  moduleDirOf,
  parseBundle,
  prChecklist,
  specsQuoting,
  type RepoModule,
} from '../applyOverride';
import { fixtureLayout } from './fixtureLayout';

const STEPS_SOURCE = `import { recordedRunStep } from './recordedRun';
const SEND = 'send-message-btn';
const N = 3;
export const STEPS: TutorialStep[] = [
  {
    id: 'opening',
    type: 'prompt',
    turn: 0,
    prompt: OPENING,
    title: 'Say it plainly',
    body: "A shop lead, describing it.",
  },
  {
    id: 'score-alone',
    type: 'prompt',
    turn: 1,
    prompt: 'Follow up',
    title: \`Ask \${N} things\`,
    body: 'Ask a follow-up.',
    anchor: 'send-message-btn',
    placement: 'left',
  },
  recordedRunStep({
    id: 'read',
    type: 'point',
    body: 'Read it.',
    anchor: SEND,
  }),
  {
    id: 'hand-over-sheet',
    type: 'prompt',
    turn: 2,
    prompt: SHEET,
    title: 'Hand it over',
  },
];
`;

// What the module serves from that source.
const STEPS: TutorialStep[] = [
  {
    id: 'opening',
    type: 'prompt',
    turn: 0,
    prompt: 'Brief',
    title: 'Say it plainly',
    body: 'A shop lead, describing it.',
  },
  {
    id: 'score-alone',
    type: 'prompt',
    turn: 1,
    prompt: 'Follow up',
    title: 'Ask 3 things',
    body: 'Ask a follow-up.',
    anchor: 'send-message-btn',
    placement: 'left',
  },
  { id: 'read', type: 'point', body: 'Read it.', anchor: 'send-message-btn' },
  { id: 'hand-over-sheet', type: 'prompt', turn: 2, prompt: 'Sheet', title: 'Hand it over' },
];

const VERSION_SOURCE = `export const ENTRIES: readonly Entry[] = [
  { id: other.id, version: 3, steps: OTHER },
  { id: fixture-mod.id, version: 8, steps: STEPS },
];
`;

const REPO: RepoModule = {
  version: 8,
  index: 1,
  steps: STEPS,
  transcript: [
    { prompt: 'Brief', reply: 'First.' },
    { prompt: 'Follow up', reply: 'Second.' },
    { prompt: 'Sheet', reply: 'Third.' },
  ],
  stepsSource: STEPS_SOURCE,
  versionSource: VERSION_SOURCE,
};

const layout = fixtureLayout();

const bundleOf = (units: OverrideUnit[], moduleId = 'fixture-mod') =>
  parseBundle({
    format: OVERRIDE_BUNDLE_FORMAT,
    owner: layout.owner,
    moduleId,
    version: 8,
    revision: 1,
    exportedAt: '2026-11-09T00:00:00.000Z',
    units,
    changes: [{ author: 'admin-1', reason: 'typo on prod', at: '2026-11-09T00:00:00.000Z' }],
  });

const idsIn = (source: string) => [...source.matchAll(/id: '([a-z-]+)'/g)].map(m => m[1]);

describe('applyBundle', () => {
  it('writes copy into steps.ts and a reply into the transcript, without a version bump', () => {
    const result = applyBundle(
      bundleOf([
        {
          kind: 'copy',
          stepId: 'opening',
          field: 'body',
          value: 'A shop lead, saying it.',
          repoValue: 'A shop lead, describing it.',
        },
        { kind: 'reply', turn: 1, value: 'Second, better.', repoValue: 'Second.' },
      ]),
      REPO,
      layout
    );
    expect(result.applied).toEqual(['copy:opening:body', 'turn:1']);
    expect(result.refused).toEqual([]);
    expect(result.manual).toEqual([]);
    expect(result.stepsSource).toBe(STEPS_SOURCE.replace(`"A shop lead, describing it."`, `"A shop lead, saying it."`));
    expect(result.transcript?.[1]).toEqual({ prompt: 'Follow up', reply: 'Second, better.' });
    expect(result.bump).toBeNull();
    expect(result.versionSource).toBeNull();
  });

  it('writes a prompt, an anchor and an order change, and bumps only this module version', () => {
    const result = applyBundle(
      bundleOf([
        {
          kind: 'prompt',
          turn: 1,
          value: { prompt: "Follow up, it's urgent", reply: 'Sooner.' },
          repoValue: { prompt: 'Follow up', reply: 'Second.' },
        },
        {
          kind: 'anchor',
          stepId: 'score-alone',
          value: { anchor: 'send-message-btn', placement: 'right' },
          repoValue: { anchor: 'send-message-btn', placement: 'left' },
        },
        {
          kind: 'order',
          value: ['score-alone', 'opening', 'read', 'hand-over-sheet'],
          repoValue: ['opening', 'score-alone', 'read', 'hand-over-sheet'],
        },
      ]),
      REPO,
      layout
    );
    expect(result.manual).toEqual([]);
    expect(result.applied).toEqual(['turn:1', 'anchor:score-alone', 'order']);
    expect(result.transcript?.[1]).toEqual({ prompt: "Follow up, it's urgent", reply: 'Sooner.' });
    const steps = result.stepsSource!;
    expect(steps).toContain(`prompt: 'Follow up, it\\'s urgent',`);
    expect(steps).toContain(`placement: 'right',`);
    expect(idsIn(steps)).toEqual(['score-alone', 'opening', 'read', 'hand-over-sheet']);
    expect(steps).toContain('recordedRunStep({');
    expect(result.bump).toEqual({ from: 8, to: 9 });
    expect(result.versionSource).toBe(VERSION_SOURCE.replace('version: 8', 'version: 9'));
  });

  it('refuses a unit whose repo value moved, and passes over one the repo already holds', () => {
    const result = applyBundle(
      bundleOf([
        { kind: 'copy', stepId: 'score-alone', field: 'body', value: 'Ask again.', repoValue: 'Ask a question.' },
        { kind: 'reply', turn: 0, value: 'First.', repoValue: 'Before.' },
      ]),
      REPO,
      layout
    );
    expect(result.refused).toEqual([
      { key: 'copy:score-alone:body', repoValue: 'Ask a question.', now: 'Ask a follow-up.' },
    ]);
    expect(result.already).toEqual(['turn:0']);
    expect(result.applied).toEqual([]);
    expect(result.stepsSource).toBeNull();
    expect(result.transcript).toBeNull();
  });

  it('prints a template, a reference or an added anchor key as a manual edit', () => {
    const result = applyBundle(
      bundleOf([
        { kind: 'copy', stepId: 'score-alone', field: 'title', value: 'Ask more', repoValue: 'Ask 3 things' },
        {
          kind: 'anchor',
          stepId: 'read',
          value: { anchor: 'score-gantt' },
          repoValue: { anchor: 'send-message-btn' },
        },
        {
          kind: 'anchor',
          stepId: 'opening',
          value: { placement: 'left' },
          repoValue: {},
        },
      ]),
      REPO,
      layout
    );
    expect(result.applied).toEqual([]);
    expect(result.manual.map(m => m.key)).toEqual(['copy:score-alone:title', 'anchor:read', 'anchor:opening']);
    expect(result.manual[0].edit).toMatch(/built in code.*"Ask more"/);
    expect(result.manual[2].edit).toMatch(/add placement on step opening/);
    expect(result.stepsSource).toBeNull();
    // A manual anchor still changes the module once a person makes it.
    expect(result.bump).toEqual({ from: 8, to: 9 });
    expect(result.versionSource).toContain('version: 9');
  });

  it('prints an order change as manual when the steps are not one literal array', () => {
    const spread = STEPS_SOURCE.replace(
      "  recordedRunStep({\n    id: 'read'",
      "  ...LATER,\n  recordedRunStep({\n    id: 'read'"
    );
    const result = applyBundle(
      bundleOf([
        {
          kind: 'order',
          value: ['score-alone', 'opening', 'read', 'hand-over-sheet'],
          repoValue: ['opening', 'score-alone', 'read', 'hand-over-sheet'],
        },
      ]),
      { ...REPO, stepsSource: spread },
      layout
    );
    expect(result.manual[0]).toMatchObject({
      key: 'order',
      edit: expect.stringContaining('score-alone, opening, read'),
    });
    expect(result.stepsSource).toBeNull();
  });
});

describe('applyBundle guards', () => {
  it('leaves the version file alone and prints the version as manual when the repo is past the export', () => {
    const bundle = {
      ...bundleOf([
        {
          kind: 'order',
          value: ['score-alone', 'opening', 'read', 'hand-over-sheet'],
          repoValue: ['opening', 'score-alone', 'read', 'hand-over-sheet'],
        },
      ]),
      version: 7,
    };
    const result = applyBundle(bundle, REPO, layout);
    expect(result.applied).toEqual(['order']);
    expect(result.versionSource).toBeNull();
    expect(result.bump).toBeNull();
    expect(result.manual.find(m => m.key === 'version')?.edit).toMatch(/already at version 8.*exported at 7/);
    expect(result.warnings.some(w => /exported at version 7/.test(w))).toBe(true);
  });

  it('refuses a unit that edits a pinned field, without editing a file or bumping', () => {
    const result = applyBundle(
      bundleOf([{ kind: 'copy', stepId: 'forte-runs', field: 'title', value: 'Changed', repoValue: 'Old' }]),
      {
        ...REPO,
        steps: [...STEPS, { id: 'forte-runs', type: 'point', title: 'Old', body: 'x', anchor: 'send-message-btn' }],
      },
      layout
    );
    expect(result.refused).toEqual([{ key: 'copy:forte-runs:title', repoValue: 'Old', now: 'Old' }]);
    expect(result.warnings.some(w => w.includes('copy:forte-runs:title') && /pinned in code/.test(w))).toBe(true);
    expect(result.stepsSource).toBeNull();
    expect(result.versionSource).toBeNull();
    expect(result.bump).toBeNull();
  });

  it('prints a prompt as manual, with the transcript untouched, when its step prompt is not a literal', () => {
    const result = applyBundle(
      bundleOf([
        {
          kind: 'prompt',
          turn: 2,
          value: { prompt: 'Sheet, again', reply: 'Third, better.' },
          repoValue: { prompt: 'Sheet', reply: 'Third.' },
        },
      ]),
      REPO,
      layout
    );
    expect(result.manual.map(m => m.key)).toEqual(['turn:2']);
    expect(result.manual[0].edit).toMatch(/change together/);
    expect(result.applied).toEqual([]);
    expect(result.transcript).toBeNull();
    expect(result.stepsSource).toBeNull();
  });
});

describe('the path guard', () => {
  const root = '/repo';

  it('refuses a module id that could leave the modules directory', () => {
    expect(() => bundleOf([{ kind: 'reply', turn: 0, value: 'a', repoValue: 'b' }], '../../etc')).toThrow(
      /not a module id/
    );
    expect(() => moduleDirOf({ ...layout, root }, '..')).toThrow();
    expect(() => moduleDirOf({ ...layout, root }, 'fixture-mod/../other-mod')).toThrow(/not a module id/);
    expect(moduleDirOf({ ...layout, root }, 'fixture-mod')).toBe(join(root, 'src/tutorials/modules/fixture-mod'));
  });

  it('writes only inside the module directory, plus the version file', () => {
    expect(() =>
      assertWritable({ ...layout, root }, 'fixture-mod', join(root, 'src/tutorials/modules/fixture-mod/steps.ts'))
    ).not.toThrow();
    expect(() => assertWritable({ ...layout, root }, 'fixture-mod', join(root, layout.version.path))).not.toThrow();
    expect(() =>
      assertWritable({ ...layout, root }, 'fixture-mod', join(root, 'src/tutorials/modules/other-mod/steps.ts'))
    ).toThrow();
    expect(() =>
      assertWritable(
        { ...layout, root },
        'fixture-mod',
        join(root, 'src/tutorials/modules/fixture-mod/../../registry.ts')
      )
    ).toThrow();
    expect(() => assertWritable({ ...layout, root }, 'fixture-mod', join(root, 'package.json'))).toThrow();
  });

  it('refuses a file that is not a bundle', () => {
    expect(() => parseBundle({ moduleId: 'fixture-mod', units: [] })).toThrow(/not a tutorial override bundle/);
  });
});

describe('the PR checklist', () => {
  it('names specs that quote the old text and says whether the version moved', () => {
    const units: OverrideUnit[] = [{ kind: 'reply', turn: 1, value: 'New.', repoValue: 'Second.' }];
    const specs = specsQuoting(units, [
      { path: 'e2e/tests/a.spec.ts', text: "expect(x).toHaveText('Second.')" },
      { path: 'e2e/tests/b.spec.ts', text: 'nothing here' },
    ]);
    expect(specs).toEqual(['e2e/tests/a.spec.ts']);
    const result = applyBundle(bundleOf(units), REPO, layout);
    const checklist = prChecklist(result, specs).join('\n');
    expect(checklist).toContain('e2e/tests/a.spec.ts');
    expect(checklist).toContain('version unchanged');
  });
});

describe('a version located by its intro identifier', () => {
  const byIntro = fixtureLayout({
    version: { path: 'content.ts', arrayName: 'CORE_TUTORIAL_CONTENT', locate: 'introId' },
  });
  const source = `export const CORE_TUTORIAL_CONTENT: readonly RepoTutorial[] = [
  { intro: otherModule, version: 5, steps: A },
  { intro: fixtureModModule, version: 8, steps: STEPS },
];
`;
  const order = [
    {
      kind: 'order' as const,
      value: ['score-alone', 'opening', 'read', 'hand-over-sheet'],
      repoValue: ['opening', 'score-alone', 'read', 'hand-over-sheet'],
    },
  ];

  it('bumps the entry whose intro names this module, wherever it sits', () => {
    const result = applyBundle(bundleOf(order), { ...REPO, index: 0, versionSource: source }, byIntro);
    expect(result.versionSource).toBe(source.replace('version: 8', 'version: 9'));
  });

  it('prints the bump as manual when no entry names the module', () => {
    const result = applyBundle(
      bundleOf(order),
      { ...REPO, versionSource: source.replace('fixtureModModule', 'elseModule') },
      byIntro
    );
    expect(result.versionSource).toBeNull();
    expect(result.manual.find(m => m.key === 'version')?.edit).toBe('set version to 9 in content.ts');
  });
});
