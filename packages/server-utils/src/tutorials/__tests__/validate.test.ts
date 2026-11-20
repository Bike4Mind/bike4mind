// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TutorialModule } from '../types';
import { csvCells, knownSelectorsOf, unsafeLinkTargets, validateSheet, validateTutorialModule } from '../validate';
import { CORE_TUTORIAL_CONTENT } from '../content';
import { FIXTURE_CONTENT } from './fixture';

const moduleOf = (): TutorialModule => ({
  ...structuredClone(FIXTURE_CONTENT.intro),
  version: 1,
  revision: 0,
  enabled: true,
  steps: [...structuredClone(FIXTURE_CONTENT.steps)],
  transcript: [...structuredClone(FIXTURE_CONTENT.transcript)],
});
const known = knownSelectorsOf([moduleOf()]);
const rulesOf = (m: TutorialModule, rules?: Parameters<typeof validateTutorialModule>[1]['rules']) =>
  validateTutorialModule(m, { known, rules }).map(i => i.rule);

describe('validateTutorialModule', () => {
  it('passes the fixture', () => {
    expect(validateTutorialModule(moduleOf(), { known })).toEqual([]);
  });

  it('refuses a repeated step id', () => {
    const m = moduleOf();
    m.steps[1].id = 'open';
    expect(rulesOf(m)).toContain('unique-ids');
  });

  it('refuses turns sent out of order', () => {
    const m = moduleOf();
    m.steps[0].turn = 1;
    m.steps[1].turn = 0;
    expect(rulesOf(m)).toContain('turn-order');
  });

  it('refuses a prompt that differs from its turn', () => {
    const m = moduleOf();
    m.steps[1].prompt = 'Something else';
    expect(validateTutorialModule(m, { known })).toContainEqual(
      expect.objectContaining({ stepId: 'ask', rule: 'prompt-matches-transcript' })
    );
  });

  it('refuses an empty reply', () => {
    const m = moduleOf();
    m.transcript[0].reply = '  ';
    expect(rulesOf(m)).toContain('reply-present');
  });

  it('refuses non-ASCII copy', () => {
    const m = moduleOf();
    m.steps[2].body = 'Caf\u00e9';
    expect(rulesOf(m)).toContain('ascii');
  });

  it('refuses a javascript link', () => {
    const m = moduleOf();
    m.steps[2].body = '[go](javascript:alert(1))';
    expect(rulesOf(m)).toContain('link-scheme');
  });

  it('refuses an anchor no shipped module uses', () => {
    const m = moduleOf();
    m.steps[2].anchor = 'made-up-anchor';
    expect(rulesOf(m)).toContain('anchor-known');
  });

  it('runs only the injected rules that belong to the module', () => {
    const rule = { rule: 'custom', check: () => [{ message: 'nope' }] };
    expect(rulesOf(moduleOf(), { fixture: [rule] })).toContain('custom');
    expect(rulesOf(moduleOf(), { other: [rule] })).not.toContain('custom');
  });
});

describe('unsafeLinkTargets', () => {
  it('lets https, mailto, fragments and relative targets through', () => {
    expect(unsafeLinkTargets('[a](https://x.test) [b](mailto:a@b.test) [c](#top) [d](/path)')).toEqual([]);
  });

  it('catches inline, reference and autolink targets', () => {
    expect(unsafeLinkTargets('[a](javascript:x)')).toEqual(['javascript:x']);
    expect(unsafeLinkTargets('[a]: data:text/html,x')).toEqual(['data:text/html,x']);
    expect(unsafeLinkTargets('<vbscript:x>')).toEqual(['vbscript:x']);
  });
});

describe('sheet rules', () => {
  it('reads quoted cells', () => {
    expect(csvCells('a,"b,c"\n1,2\n')).toEqual(['a', 'b,c', '1', '2']);
  });

  it('accepts a small csv and refuses an oversized one', () => {
    expect(validateSheet({ name: 'a.csv', csv: 'a,b\n1,2\n' })).toEqual([]);
    expect(validateSheet({ name: 'a.csv', csv: 'x'.repeat(70 * 1024) }).length).toBeGreaterThan(0);
  });
});

describe('the shipped core tutorials', () => {
  it('validates every module against the selectors the shipped modules name', () => {
    const modules = CORE_TUTORIAL_CONTENT.map(t => ({
      ...t.intro,
      version: t.version,
      revision: 0,
      enabled: t.enabled,
      steps: [...t.steps],
      transcript: [...t.transcript],
    }));
    const known = knownSelectorsOf(modules);
    for (const m of modules) expect(validateTutorialModule(m, { known }), m.id).toEqual([]);
  });
});
