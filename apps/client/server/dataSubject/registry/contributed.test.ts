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

// Registered on the same mongoose instance the freshly imported registry module will see.
const fixtureModels: Record<string, Record<string, unknown>> = {
  FixtureOverlayNote: { ownerId: String },
  FixtureParent: { ownerId: String, key: String },
  FixtureChild: { parentId: String, ownerId: String },
  FixtureLeaf: { parentId: String },
  FixtureUniqueNote: { ownerId: String, handle: { type: String, unique: true } },
  FixtureScalarNote: { ownerId: String, label: String },
  FixtureArrayNote: { ownerId: String, members: [String] },
};

const loadRegistry = async (registries: unknown[]) => {
  h.registries = registries;
  vi.resetModules();
  const { mongoose } = await import('@bike4mind/database');
  for (const [name, definition] of Object.entries(fixtureModels)) {
    if (!mongoose.modelNames().includes(name)) mongoose.model(name, new mongoose.Schema(definition));
  }
  return import('./index');
};

const ownerRef = { path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' } as const;
const parentHolder = { kind: 'holder', references: [ownerRef] } as const;

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

  it('returns a frozen copy the overlay cannot change after validation', async () => {
    const { assertContributedRegistry } = await loadRegistry([]);
    const source = { FixtureOverlayNote: { ...fixture.FixtureOverlayNote } } as ContributedDataHolderRegistry;
    const result = assertContributedRegistry(source);
    expect(result).not.toBe(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.FixtureOverlayNote)).toBe(true);
    expect(() => {
      (result as Record<string, unknown>).Other = {};
    }).toThrow();
    expect(() => {
      (result.FixtureOverlayNote as { kind: string }).kind = 'noUserData';
    }).toThrow();
    expect(result.FixtureOverlayNote).toEqual(source.FixtureOverlayNote);
  });

  describe('structure', () => {
    const child = { kind: 'viaParent', parent: 'FixtureParent', foreignKey: 'parentId' } as const;

    it('accepts a viaParent under a contributed holder', async () => {
      await expect(loadRegistry([{ FixtureParent: parentHolder, FixtureChild: child }])).resolves.toBeDefined();
    });

    it('accepts a viaParent under a core holder', async () => {
      const entry = { kind: 'viaParent', parent: 'Annotation', foreignKey: 'parentId' };
      await expect(loadRegistry([{ FixtureChild: entry }])).resolves.toBeDefined();
    });

    it.each([
      ['a missing parent', { FixtureChild: child }, /"FixtureChild".*"FixtureParent" is not in the registry/],
      [
        'a parent of kind noUserData',
        { FixtureParent: { kind: 'noUserData', note: 'x' }, FixtureChild: child },
        /"FixtureChild".*does not end at a holder/,
      ],
      [
        'a chain ending at noUserData',
        {
          FixtureChild: child,
          FixtureParent: { kind: 'viaParent', parent: 'FixtureLeaf', foreignKey: 'parentId' },
          FixtureLeaf: { kind: 'noUserData', note: 'x' },
        },
        /"FixtureChild".*FixtureChild -> FixtureParent -> FixtureLeaf does not end at a holder/,
      ],
      [
        'a parent cycle',
        {
          FixtureParent: { kind: 'viaParent', parent: 'FixtureLeaf', foreignKey: 'parentId' },
          FixtureLeaf: { kind: 'viaParent', parent: 'FixtureParent', foreignKey: 'parentId' },
        },
        /"Fixture(Parent|Leaf)".*parent cycle/,
      ],
      [
        'an undeclared parentKey',
        { FixtureParent: parentHolder, FixtureChild: { ...child, parentKey: 'nope' } },
        /"FixtureChild".*parentKey "nope"/,
      ],
      [
        'an undeclared reference path',
        { FixtureOverlayNote: { kind: 'holder', references: [{ ...ownerRef, path: 'missingId' }] } },
        /"FixtureOverlayNote".*missingId/,
      ],
      [
        'alsoRedact on a unique-index path',
        {
          FixtureUniqueNote: {
            kind: 'holder',
            references: [{ path: 'ownerId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['handle'] }],
          },
        },
        /"FixtureUniqueNote".*unique index: handle/,
      ],
      [
        'pullFromArray on a non-array path',
        {
          FixtureScalarNote: {
            kind: 'holder',
            references: [{ path: 'label', matchBy: 'userId', action: 'pullFromArray' }],
          },
        },
        /"FixtureScalarNote".*pullFromArray path "label"/,
      ],
    ])('rejects %s', async (_name, registry, message) => {
      await expect(loadRegistry([registry])).rejects.toThrow(message);
    });

    it('accepts pullFromArray on an array path', async () => {
      const entry = {
        kind: 'holder',
        references: [{ path: 'members', matchBy: 'userId', action: 'pullFromArray' }],
      };
      await expect(loadRegistry([{ FixtureArrayNote: entry }])).resolves.toBeDefined();
    });

    it('rejects a contributed model that is not registered with mongoose', async () => {
      await expect(loadRegistry([{ FixtureUnregistered: parentHolder }])).rejects.toThrow(
        /"FixtureUnregistered".*not a registered Mongoose model/
      );
    });
  });
});
