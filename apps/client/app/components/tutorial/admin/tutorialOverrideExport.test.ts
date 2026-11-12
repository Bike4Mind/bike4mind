import { describe, expect, it } from 'vitest';
import {
  MODULE_BUNDLE_FORMAT,
  ModuleBundleSchema,
  OVERRIDE_BUNDLE_FORMAT,
  OverrideBundleSchema,
  type TutorialDraftContent,
} from '@bike4mind/common';
import type { TutorialModuleOverrideRow } from './adminTypes';
import { moduleBundleOf, overrideBundleOf } from './tutorialOverrideExport';

const NOW = new Date('2026-11-12T10:00:00Z');

const content: TutorialDraftContent = {
  moduleId: 'my-sites',
  title: 'Pick the sites',
  pitch: 'p',
  transcript: [{ prompt: 'Pick sites', reply: 'Sure.' }],
  steps: [],
  finale: { title: 'F', body: 'B' },
  visibility: { entitlement: 'pro:tools' },
};

describe('moduleBundleOf', () => {
  it('stamps the owner and parses as a module bundle', () => {
    const bundle = moduleBundleOf(content, 'core', NOW);
    expect(bundle.owner).toBe('core');
    expect(bundle.format).toBe(MODULE_BUNDLE_FORMAT);
    expect(bundle.exportedAt).toBe(NOW.toISOString());
    expect(ModuleBundleSchema.parse(bundle).owner).toBe('core');
  });
});

describe('overrideBundleOf', () => {
  const row = {
    moduleId: 'alpha',
    version: 2,
    revision: 1,
    fields: [{ kind: 'reply', turn: 1, value: 'Better.', repoValue: 'Old.' }],
    report: { states: [{ key: 'turn:1', state: 'live' }] },
    lastFieldsChange: { actorId: 'u1', reason: 'fix', at: '2026-11-11T00:00:00Z' },
  } as unknown as TutorialModuleOverrideRow;

  it('stamps the owner on an override bundle', () => {
    const bundle = overrideBundleOf(row, 'core', NOW);
    expect(bundle.owner).toBe('core');
    expect(bundle.format).toBe(OVERRIDE_BUNDLE_FORMAT);
    expect(OverrideBundleSchema.safeParse(bundle).success).toBe(true);
  });
});
