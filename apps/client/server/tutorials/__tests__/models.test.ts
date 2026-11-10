// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tutorialModels } from '../models';

const OWNER = { prefix: 'acme', modelPrefix: 'Acme' };
const KINDS = ['Progress', 'Override', 'OverrideChange', 'Draft'] as const;

describe('tutorialModels', () => {
  it('derives model and collection names from an owner prefix', () => {
    const m = tutorialModels(OWNER);
    expect(KINDS.map(k => m[k].modelName)).toEqual([
      'AcmeTutorialProgress',
      'AcmeTutorialOverride',
      'AcmeTutorialOverrideChange',
      'AcmeTutorialDraft',
    ]);
    expect(KINDS.map(k => m[k].collection.collectionName)).toEqual([
      'acmetutorialprogress',
      'acmetutorialoverrides',
      'acmetutorialoverridechanges',
      'acmetutorialdrafts',
    ]);
  });

  it('gives core names that cannot collide with an owner', () => {
    const core = tutorialModels({ prefix: '', modelPrefix: 'Core' });
    const owner = tutorialModels(OWNER);
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
    const first = tutorialModels(OWNER);
    expect(tutorialModels({ ...OWNER })).toBe(first);
    expect(tutorialModels({ prefix: '', modelPrefix: 'Core' })).not.toBe(first);
  });

  it('keeps empty objects in a draft and indexes the audit trail by module and time', () => {
    const m = tutorialModels(OWNER);
    expect(m.Draft.schema.get('minimize')).toBe(false);
    expect(m.OverrideChange.schema.indexes()).toContainEqual([{ moduleId: 1, createdAt: -1 }, expect.anything()]);
  });
});
