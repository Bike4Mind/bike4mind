// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tutorialModels } from '../models';

const OVERLAY = { prefix: 'optihashi', modelPrefix: 'OptiHashi' };
const KINDS = ['Progress', 'Override', 'OverrideChange', 'Draft'] as const;

describe('tutorialModels', () => {
  it('pins the names an existing owner already stores its rows under', () => {
    const m = tutorialModels(OVERLAY);
    expect(KINDS.map(k => m[k].modelName)).toEqual([
      'OptiHashiTutorialProgress',
      'OptiHashiTutorialOverride',
      'OptiHashiTutorialOverrideChange',
      'OptiHashiTutorialDraft',
    ]);
    expect(KINDS.map(k => m[k].collection.collectionName)).toEqual([
      'optihashitutorialprogress',
      'optihashitutorialoverrides',
      'optihashitutorialoverridechanges',
      'optihashitutorialdrafts',
    ]);
  });

  it('gives core names that cannot collide with an owner', () => {
    const core = tutorialModels({ prefix: '', modelPrefix: 'Core' });
    const owner = tutorialModels(OVERLAY);
    expect(KINDS.map(k => core[k].modelName)).toEqual([
      'CoreTutorialProgress',
      'CoreTutorialOverride',
      'CoreTutorialOverrideChange',
      'CoreTutorialDraft',
    ]);
    expect(KINDS.map(k => core[k].collection.collectionName)).toEqual([
      'tutorialprogress',
      'tutorialoverrides',
      'tutorialoverridechanges',
      'tutorialdrafts',
    ]);
    for (const k of KINDS) {
      expect(core[k].modelName).not.toBe(owner[k].modelName);
      expect(core[k].collection.collectionName).not.toBe(owner[k].collection.collectionName);
    }
  });

  it('is memoized per names, so a second call registers nothing new', () => {
    const first = tutorialModels(OVERLAY);
    expect(tutorialModels({ ...OVERLAY })).toBe(first);
    expect(tutorialModels({ prefix: '', modelPrefix: 'Core' })).not.toBe(first);
  });

  it('keeps empty objects in a draft and indexes the audit trail by module and time', () => {
    const m = tutorialModels(OVERLAY);
    expect(m.Draft.schema.get('minimize')).toBe(false);
    expect(m.OverrideChange.schema.indexes()).toContainEqual([{ moduleId: 1, createdAt: -1 }, expect.anything()]);
  });
});
