// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MODULE_BUNDLE_FORMAT,
  type TutorialDraftContent,
  type TutorialModuleBundle,
  type TutorialTurn,
} from '@bike4mind/common';
import { CORE_DRAFT_PROFILE, CORE_DRAFT_SELECTORS, coreDraftCore } from '../../coreDraftProfile';
import { coreKnownSelectors } from '../../coreDraftProfile';
import { validateTutorialModule } from '../../validate';
import { applyModuleBundle, identifiersOf, isModuleBundle, moduleChecklist, parseModuleBundle } from '../applyModule';
import { assertWritable } from '../applyOverride';
import { coreLayout, coreModuleFiles } from '../coreLayout';

const transcript: TutorialTurn[] = [
  { prompt: 'Plan my week', reply: 'Here is a plan.' },
  { prompt: 'Use my sheet', reply: 'Done with the sheet.', attachSheet: true },
  { prompt: 'Tighten it', reply: 'Tighter.' },
];
const root = mkdtempSync(join(tmpdir(), 'core-module-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const layout = coreLayout(root);

function made(patch: Partial<TutorialDraftContent> = {}): TutorialDraftContent {
  const base: TutorialDraftContent = {
    moduleId: 'my-week',
    title: 'Plan the week',
    pitch: 'Plan a week from a sheet.',
    transcript,
    sheet: { name: 'week.csv', csv: 'day,hours\nmon,8\n' },
    steps: CORE_DRAFT_PROFILE.starterSteps(transcript),
    finale: CORE_DRAFT_PROFILE.defaultFinale,
    visibility: { entitlement: 'week:planner' },
    ...patch,
  };
  return { ...base, steps: coreDraftCore.normalizeDraftSteps(base) };
}

// The shape the drafts card exports (the card's own helper arrives with its PR).
const moduleBundleOf = (content: TutorialDraftContent, owner: string): TutorialModuleBundle => ({
  format: MODULE_BUNDLE_FORMAT,
  owner,
  moduleId: content.moduleId,
  exportedAt: '2026-11-12T00:00:00.000Z',
  content,
});
const exported = (content: TutorialDraftContent, owner = 'core') =>
  parseModuleBundle(JSON.parse(JSON.stringify(moduleBundleOf(content, owner))));

describe('parseModuleBundle', () => {
  it('reads back what the drafts card exports, owner included', () => {
    const content = made();
    expect(exported(content)).toEqual({ owner: 'core', moduleId: 'my-week', content });
    expect(isModuleBundle(moduleBundleOf(content, 'core'))).toBe(true);
  });

  it('refuses another format, and a bundle whose content names another module', () => {
    const bundle = moduleBundleOf(made(), 'core');
    expect(() => parseModuleBundle({ ...bundle, format: 'tutorial-overrides/1' })).toThrow(/module bundle/);
    expect(() => parseModuleBundle({ ...bundle, moduleId: 'other' })).toThrow(/different modules/);
  });
});

describe('identifiersOf', () => {
  it('names the exports after the id, and keeps a digit-led id a valid identifier', () => {
    expect(identifiersOf('acme-routing')).toEqual({ upper: 'ACME_ROUTING', camel: 'acmeRouting' });
    expect(identifiersOf('3pl')).toEqual({ upper: 'M_3PL', camel: 'm3pl' });
  });
});

describe('a core-made bundle', () => {
  it('writes the module directory under the modules dir, and its steps re-validate clean', async () => {
    const bundle = exported(made());
    const result = applyModuleBundle(bundle, layout, { dryRun: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dir = join(root, 'apps/client/server/tutorials/modules/my-week');
    expect(result.dir).toBe(dir);
    expect(result.files.map(p => relative(dir, p)).sort()).toEqual(
      ['module.ts', 'sheet.ts', 'steps.ts', 'transcript.json'].sort()
    );
    for (const path of result.files) expect(() => assertWritable(layout, 'my-week', path)).not.toThrow();
    expect(readFileSync(join(dir, 'steps.ts'), 'utf8')).toMatch(/^\s*id: "turn-0"/m);

    const steps = (await import(join(dir, 'steps.ts'))).MY_WEEK_STEPS;
    const intro = (await import(join(dir, 'module.ts'))).myWeekModule;
    expect(steps).toEqual(bundle.content.steps);
    expect(intro).toMatchObject({ id: 'my-week', title: 'Plan the week', sheet: bundle.content.sheet });
    expect(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'))).toEqual(transcript);
    const union = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b]);
    const known = {
      anchors: union(coreKnownSelectors.anchors, CORE_DRAFT_SELECTORS.anchors),
      anchorScopes: union(coreKnownSelectors.anchorScopes, CORE_DRAFT_SELECTORS.anchorScopes),
      avoids: union(coreKnownSelectors.avoids, CORE_DRAFT_SELECTORS.avoids),
    };
    expect(
      validateTutorialModule({ ...intro, version: 1, revision: 0, enabled: true, steps, transcript }, { known })
    ).toEqual([]);
  });

  it('prints registration snippets that name the draft visibility and keep the module off', () => {
    const { registration } = coreModuleFiles('/x/my-week', made());
    const [registry, content] = registration;
    expect(registry.file).toMatch(/registry\.ts$/);
    expect(registry.text).toContain('visibility: { entitlement: "week:planner" }');
    expect(registry.text).toContain('enabled: false');
    expect(content.file).toMatch(/content\.ts$/);
    expect(content.text).toContain('intro: myWeekModule');
    expect(content.text).toContain('steps: MY_WEEK_STEPS');
    expect(coreModuleFiles('/x/y', made({ visibility: { public: true } })).registration[0].text).toContain(
      'visibility: { public: true }'
    );
  });

  it('writes nothing on a dry run, and refuses a directory that exists', () => {
    const bundle = exported(made({ moduleId: 'dry-week' }));
    expect(applyModuleBundle(bundle, layout, { dryRun: true }).ok).toBe(true);
    expect(existsSync(join(root, 'apps/client/server/tutorials/modules/dry-week'))).toBe(false);
    const again = exported(made());
    expect(applyModuleBundle(again, layout, { dryRun: false })).toMatchObject({ ok: false, reason: 'exists' });
  });

  it('reports a draft that breaks a rule, such as no visibility, and writes nothing', () => {
    const bundle = exported(made({ moduleId: 'no-vis', visibility: undefined }));
    const result = applyModuleBundle(bundle, layout, { dryRun: false });
    expect(result).toMatchObject({ ok: false, reason: 'rules' });
    expect(result.ok === false && result.reason === 'rules' && result.issues.map(i => i.rule)).toContain(
      'draft-visibility'
    );
    expect(existsSync(join(root, 'apps/client/server/tutorials/modules/no-vis'))).toBe(false);
  });

  it('refuses an id that would write outside the modules directory', () => {
    const bundle = { owner: 'core', moduleId: '../escape', content: made({ moduleId: '../escape' }) };
    expect(() => applyModuleBundle(bundle, layout, { dryRun: false })).toThrow(/not a module id/);
  });

  it('writes ASCII only, escaping what a captured sheet or reply carries', async () => {
    const content = made({
      moduleId: 'accented',
      sheet: { name: 'sites.csv', csv: 'site,owner\nNorth,Jos\u00e9 \u2013 ops\n' },
    });
    const { dir, files } = coreModuleFiles(join(root, 'accented-out', 'accented'), content);
    for (const [path, text] of files) {
      expect(text).toMatch(/^[\t\n\r\x20-\x7e]*$/);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    expect((await import(join(dir, 'sheet.ts'))).ACCENTED_SHEET_CSV).toBe(content.sheet!.csv);
  });

  it('leaves the sheet out of a module captured without one', () => {
    const { files } = coreModuleFiles('/x/y', made({ sheet: undefined, steps: [] }));
    expect(files.some(([p]) => p.endsWith('sheet.ts'))).toBe(false);
  });

  it('names the registries and the fields command in its checklist', () => {
    const list = moduleChecklist(layout, 'my-week').join('\n');
    expect(list).toContain('apps/client/server/tutorials/registry.ts');
    expect(list).toContain('tutorials:fields');
  });
});
