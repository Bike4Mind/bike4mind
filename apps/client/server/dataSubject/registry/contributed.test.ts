import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContributedDataHolderRegistry } from '../types';

const h = vi.hoisted(() => ({ registries: [] as unknown[] }));

vi.mock('@server/premium-generated/premiumDataSubjectRegistry.generated', () => ({
  get premiumDataSubjectRegistries() {
    return h.registries;
  },
}));

const fixture: ContributedDataHolderRegistry = {
  FixtureOverlayNote: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
  },
};

const loadRegistry = async (registries: unknown[]) => {
  h.registries = registries;
  vi.resetModules();
  return import('./index');
};

afterEach(() => {
  h.registries = [];
});

describe('contributed data holder registry', () => {
  it('classifies a contributed model so the coverage assertion passes', async () => {
    const { findUnclassifiedModels } = await loadRegistry([fixture]);
    expect(findUnclassifiedModels(['FixtureOverlayNote'])).toEqual([]);
    const { assertEveryModelClassified } = await import('../subjectMatcher');
    expect(() => assertEveryModelClassified(['User', 'FixtureOverlayNote'])).not.toThrow();
  });

  it('leaves the model unclassified when nothing contributes', async () => {
    const { findUnclassifiedModels } = await loadRegistry([]);
    expect(findUnclassifiedModels(['FixtureOverlayNote'])).toEqual(['FixtureOverlayNote']);
  });

  it('equals the core-only registry when nothing contributes', async () => {
    const { DATA_HOLDER_REGISTRY: empty } = await loadRegistry([]);
    const { DATA_HOLDER_REGISTRY: withFixture } = await loadRegistry([fixture]);
    expect(Object.keys(withFixture).filter(name => !(name in empty))).toEqual(['FixtureOverlayNote']);
    expect({ ...withFixture, FixtureOverlayNote: undefined }).toEqual({ ...empty, FixtureOverlayNote: undefined });
  });

  it('throws when a contributed model collides with a core one', async () => {
    await expect(loadRegistry([{ User: { kind: 'noUserData', note: 'x' } }])).rejects.toThrow(
      /"User" is classified twice/
    );
  });

  it('throws when two overlays classify the same model', async () => {
    await expect(loadRegistry([fixture, fixture])).rejects.toThrow(/"FixtureOverlayNote" is classified twice/);
  });

  it.each([
    ['subject', { kind: 'subject', secretPaths: [], references: [] }],
    ['discriminator', { kind: 'discriminator', base: 'User' }],
  ])('rejects a contributed %s entry', async (kind, entry) => {
    await expect(loadRegistry([{ FixtureOverlayNote: entry }])).rejects.toThrow(
      new RegExp(`kind "${kind}", which an overlay may not use`)
    );
  });

  it('rejects a contributed entry that names a beforeErasure hook', async () => {
    const entry = { ...fixture.FixtureOverlayNote, beforeErasure: ['purgeUserPublishedArtifacts'] };
    await expect(loadRegistry([{ FixtureOverlayNote: entry }])).rejects.toThrow(/may not declare beforeErasure/);
  });
});
