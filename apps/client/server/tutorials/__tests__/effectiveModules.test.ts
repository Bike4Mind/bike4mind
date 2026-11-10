// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { structuralDigestOf, type OverrideUnit } from '../overrides';
import { digestMove, tutorialContent, type TutorialOverrideState } from '../effectiveModules';
import { knownSelectorsOf } from '../validate';
import { FIXTURE_CONTENT, FIXTURE_POLICY } from './fixture';

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTransaction: (fn: (s: unknown) => unknown) => fn(undefined),
}));

const open = FIXTURE_CONTENT.steps.find(s => s.id === 'open')!;
const edit = (value: string, repoValue = open.body): OverrideUnit => ({
  kind: 'copy',
  stepId: 'open',
  field: 'body',
  value,
  repoValue,
});

function build(rows: TutorialOverrideState[] = [], extra: Partial<Parameters<typeof tutorialContent>[0]> = {}) {
  const Override = {
    find: vi.fn(() => ({ lean: async () => rows })),
    updateOne: vi.fn(async () => ({})),
    findOneAndUpdate: vi.fn(async () => null),
  };
  const OverrideChange = { create: vi.fn(async () => []) };
  const content = tutorialContent({
    models: { Override, OverrideChange } as never,
    repo: [FIXTURE_CONTENT],
    policy: FIXTURE_POLICY,
    validator: { known: knownSelectorsOf([{ steps: FIXTURE_CONTENT.steps }]) },
    ...extra,
  });
  return { content, Override, OverrideChange };
}
const row = (fields: unknown[], extra: Partial<TutorialOverrideState> = {}): TutorialOverrideState => ({
  moduleId: 'fixture',
  revision: 0,
  fields,
  ...extra,
});

describe('effectiveTutorials', () => {
  it('serves the repo content when there are no overrides', () => {
    const { modules } = build().content.effectiveTutorials([]);
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ id: 'fixture', enabled: true, revision: 0, steps: FIXTURE_CONTENT.steps });
  });

  it('applies a live copy edit', () => {
    const { modules } = build().content.effectiveTutorials([row([edit('Edited.')])]);
    expect(modules[0].steps.find(s => s.id === 'open')!.body).toBe('Edited.');
  });

  it('can switch a module off but never release one the repo holds off', () => {
    const { content } = build();
    expect(content.effectiveTutorials([{ moduleId: 'fixture', revision: 0, enabled: false }]).modules[0].enabled).toBe(
      false
    );
    const off = tutorialContent({
      models: build().Override as never,
      repo: [{ ...FIXTURE_CONTENT, enabled: false }],
      policy: FIXTURE_POLICY,
      validator: { known: knownSelectorsOf([]) },
    });
    expect(off.effectiveTutorials([{ moduleId: 'fixture', revision: 0, enabled: true }]).modules[0].enabled).toBe(
      false
    );
  });

  it('falls back to the repo and reports why when an override breaks a rule', () => {
    const result = build().content.effectiveTutorials([row([edit('Caf\u00e9')])]);
    expect(result.modules[0].steps.find(s => s.id === 'open')!.body).toBe(open.body);
    expect(result.overrides.fixture.rejected.map(i => i.rule)).toContain('ascii');
  });

  it('falls back when an override edits a locked field', () => {
    const locked: OverrideUnit = { ...edit('x'), field: 'doneBody' };
    const result = build().content.effectiveTutorials([row([locked])]);
    expect(result.overrides.fixture.rejected.map(i => i.rule)).toContain('override-locked');
  });

  it('falls back when the stored fields do not parse', () => {
    const result = build().content.effectiveTutorials([row([{ kind: 'nonsense' }])]);
    expect(result.overrides.fixture.rejected.map(i => i.rule)).toEqual(['override-unparsable']);
  });

  it('lets an owner append closing steps', () => {
    const closing = vi.fn((steps, _t, offers) => [
      ...steps,
      { id: 'next', type: 'point' as const, title: 'Next', body: String(offers('fixture')) },
    ]);
    const { modules } = build([], { closingSteps: closing }).content.effectiveTutorials([]);
    expect(modules[0].steps.at(-1)).toMatchObject({ id: 'next', body: 'true' });
  });
});

describe('digestMove', () => {
  it('adopts a first digest, keeps a matching one, and bumps only from a current build', () => {
    expect(digestMove({ moduleId: 'm', revision: 0 }, 'd', 1)).toBe('adopt');
    expect(digestMove({ moduleId: 'm', revision: 0, structuralDigest: 'd' }, 'd', 1)).toBe('none');
    expect(digestMove({ moduleId: 'm', revision: 0, structuralDigest: 'a', digestRepoVersion: 1 }, 'd', 1)).toBe(
      'bump'
    );
    expect(digestMove({ moduleId: 'm', revision: 0, structuralDigest: 'a', digestRepoVersion: 2 }, 'd', 1)).toBe(
      'none'
    );
  });
});

describe('resolve', () => {
  it('adopts the digest on a row that has none, without a bump', async () => {
    const { content, Override } = build([row([edit('Edited.')])]);
    await content.resolve();
    expect(Override.updateOne).toHaveBeenCalledWith(
      { moduleId: 'fixture', structuralDigest: { $exists: false } },
      { $set: { structuralDigest: structuralDigestOf([edit('Edited.')]), digestRepoVersion: 1 } }
    );
  });

  it('bumps the revision with an audit row when the served structure moved', async () => {
    const ids = FIXTURE_CONTENT.steps.map(s => s.id);
    const order: OverrideUnit = { kind: 'order', value: [ids[1], ids[0], ids[2]], repoValue: ids };
    const stale = row([order], { structuralDigest: 'old', digestRepoVersion: 1 });
    const { content, Override, OverrideChange } = build([stale]);
    Override.findOneAndUpdate.mockResolvedValueOnce({ revision: 1 } as never);
    Override.find.mockReturnValueOnce({ lean: async () => [stale] }).mockReturnValue({
      lean: async () => [{ ...stale, structuralDigest: structuralDigestOf([order]), revision: 1 }],
    });
    const { modules } = await content.resolve();
    expect(OverrideChange.create).toHaveBeenCalledWith(
      [expect.objectContaining({ field: 'revision', actorId: 'system', before: '0', after: '1' })],
      { session: undefined }
    );
    expect(modules[0].revision).toBe(1);
  });
});
