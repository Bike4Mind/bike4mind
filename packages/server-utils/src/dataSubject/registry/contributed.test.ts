import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContributedDataHolderRegistry } from '../types';

vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));

const h = vi.hoisted(() => ({ registries: [] as unknown[] }));

vi.mock('../../premium-generated/premiumDataSubjectRegistry.generated', () => ({
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
  FixtureKindNote: { ownerId: String, kind: { type: String, enum: ['a', 'b'] }, label: String },
  FixtureOrgNote: { ownerId: String, organizationId: String },
  FixtureDiscBase: { ownerId: String },
};

const loadRegistry = async (registries: unknown[]) => {
  h.registries = registries;
  vi.resetModules();
  const { mongoose } = await import('@bike4mind/database');
  for (const [name, definition] of Object.entries(fixtureModels)) {
    if (!mongoose.modelNames().includes(name)) mongoose.model(name, new mongoose.Schema(definition));
  }
  if (!mongoose.modelNames().includes('FixtureDiscChild')) {
    mongoose.model('FixtureDiscBase').discriminator('FixtureDiscChild', new mongoose.Schema({ extra: String }));
  }
  return import('./index');
};

const lateModels: Record<string, Record<string, unknown>> = { FixtureLateParent: { ownerId: String, key: String } };

const ownerRef = { path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' } as const;
const parentHolder = { kind: 'holder', references: [ownerRef] } as const;

afterEach(() => {
  h.registries = [];
});

const brokenEntries: [string, unknown[], RegExp][] = [
  ['a collision with a core model', [{ User: { kind: 'noUserData', note: 'x' } }], /"User" is classified twice/],
  ['a collision between two overlays', [fixture, fixture], /"FixtureOverlayNote" is classified twice/],
  [
    'a disallowed kind',
    [{ FixtureOverlayNote: { kind: 'subject', secretPaths: [], references: [] } }],
    /"FixtureOverlayNote" has kind "subject", which an overlay may not use/,
  ],
  [
    'a beforeErasure hook',
    [{ FixtureOverlayNote: { ...fixture.FixtureOverlayNote, beforeErasure: ['purgeUserPublishedArtifacts'] } }],
    /"FixtureOverlayNote" may not declare beforeErasure/,
  ],
  [
    'a missing parent',
    [{ FixtureChild: { kind: 'viaParent', parent: 'FixtureParent', foreignKey: 'parentId' } }],
    /"FixtureChild".*"FixtureParent" is not in the registry/,
  ],
];

describe('contributed data holder registry', () => {
  describe('a malformed entry', () => {
    it.each([
      ['a null holder', null],
      ['a primitive holder', 'holder'],
      ['a holder containing a function', { ...fixture.FixtureOverlayNote, hook: () => {} }],
      [
        'a holder containing a mongoose Schema',
        async () => {
          const { mongoose } = await import('@bike4mind/database');
          return { ...fixture.FixtureOverlayNote, schema: new mongoose.Schema({ a: String }) };
        },
      ],
    ])('does not throw at load for %s, and throws naming the model on first use', async (_name, holder) => {
      const entry = typeof holder === 'function' ? await holder() : holder;
      const { assertContributedRegistryValid, DATA_HOLDER_REGISTRY } = await loadRegistry([
        { FixtureOverlayNote: entry },
      ]);
      expect(DATA_HOLDER_REGISTRY).not.toHaveProperty('FixtureOverlayNote');
      expect(() => assertContributedRegistryValid()).toThrow(/"FixtureOverlayNote"/);
    });

    it('collects a registry that is not an object instead of throwing', async () => {
      const { assertContributedRegistryValid } = await loadRegistry([null, 'x', fixture]);
      expect(() => assertContributedRegistryValid()).toThrow(/not an object/);
    });

    it('accepts a where value that is an ObjectId, and keeps it usable', async () => {
      const { mongoose } = await import('@bike4mind/database');
      const id = new mongoose.Types.ObjectId();
      const entry = { kind: 'holder', references: [{ ...ownerRef, where: { kind: id } }] };
      const { assertContributedRegistryValid, DATA_HOLDER_REGISTRY } = await loadRegistry([{ FixtureKindNote: entry }]);
      const stored = (DATA_HOLDER_REGISTRY.FixtureKindNote as unknown as { references: { where: { kind: unknown } }[] })
        .references[0].where.kind;
      expect(String(stored)).toBe(id.toHexString());
      expect(mongoose.isValidObjectId(stored)).toBe(true);
      // Mongoose cannot declare an ObjectId enum, so the allowed value is added to the path by hand.
      (mongoose.model('FixtureKindNote').schema.path('kind') as unknown as { enumValues: unknown[] }).enumValues.push(
        id
      );
      expect(() => assertContributedRegistryValid()).not.toThrow();
    });
  });

  describe('discriminator rule', () => {
    it('rejects a contributed holder that Mongoose registers as a discriminator', async () => {
      const { assertContributedRegistryValid } = await loadRegistry([{ FixtureDiscChild: parentHolder }]);
      expect(() => assertContributedRegistryValid()).toThrow(/"FixtureDiscChild".*discriminator of "FixtureDiscBase"/);
    });

    it('accepts a contributed holder on a base model that has a discriminator', async () => {
      const { assertContributedRegistryValid } = await loadRegistry([{ FixtureDiscBase: parentHolder }]);
      expect(() => assertContributedRegistryValid()).not.toThrow();
    });
  });

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

  it('equals the core-only registry when nothing contributes, and the first-use check passes', async () => {
    const empty = await loadRegistry([]);
    expect(() => empty.assertContributedRegistryValid()).not.toThrow();
    const { DATA_HOLDER_REGISTRY: withFixture, assertContributedRegistryValid } = await loadRegistry([fixture]);
    expect(() => assertContributedRegistryValid()).not.toThrow();
    expect(Object.keys(withFixture).filter(name => !(name in empty.DATA_HOLDER_REGISTRY))).toEqual([
      'FixtureOverlayNote',
    ]);
    expect({ ...withFixture, FixtureOverlayNote: undefined }).toEqual({
      ...empty.DATA_HOLDER_REGISTRY,
      FixtureOverlayNote: undefined,
    });
  });

  describe('a broken contribution', () => {
    it.each(brokenEntries)(
      'does not throw at load for %s, and throws on first use',
      async (_name, registries, message) => {
        const { assertContributedRegistryValid } = await loadRegistry(registries);
        expect(() => assertContributedRegistryValid()).toThrow(message);
      }
    );

    it.each(brokenEntries)('refuses erasure, audit and the export check for %s', async (_name, registries, message) => {
      await loadRegistry(registries);
      const { erasureRegistry } = await import('../erasureRegistry');
      const { assertEveryModelClassified } = await import('../subjectMatcher');
      const subject = { userId: 'u', email: null };
      await expect(erasureRegistry.erase(subject, async () => {}, undefined)).rejects.toThrow(message);
      await expect(erasureRegistry.audit(subject)).rejects.toThrow(message);
      expect(() => assertEveryModelClassified([])).toThrow(message);
    });

    it('keeps the core entry on a collision', async () => {
      const core = await loadRegistry([]);
      const { DATA_HOLDER_REGISTRY } = await loadRegistry([{ User: { kind: 'noUserData', note: 'x' } }]);
      expect(DATA_HOLDER_REGISTRY.User).toEqual(core.DATA_HOLDER_REGISTRY.User);
    });

    it('lists every problem in one error', async () => {
      const { assertContributedRegistryValid } = await loadRegistry([
        { User: { kind: 'noUserData', note: 'x' }, FixtureOverlayNote: { kind: 'discriminator', base: 'User' } },
      ]);
      expect(() => assertContributedRegistryValid()).toThrow(/"User" is classified twice[\s\S]*"FixtureOverlayNote"/);
    });
  });

  it('passes once a parent model registers after the module loaded, with no stale failure', async () => {
    const lateChild = { kind: 'viaParent', parent: 'FixtureLateParent', foreignKey: 'parentId' } as const;
    const { assertContributedRegistryValid } = await loadRegistry([
      { FixtureLateParent: parentHolder, FixtureChild: lateChild },
    ]);
    expect(() => assertContributedRegistryValid()).toThrow(/"FixtureLateParent".*not a registered Mongoose model/);
    const { mongoose } = await import('@bike4mind/database');
    mongoose.model('FixtureLateParent', new mongoose.Schema(lateModels.FixtureLateParent));
    expect(() => assertContributedRegistryValid()).not.toThrow();
    expect(() => assertContributedRegistryValid()).not.toThrow();
  });

  it('deep-freezes a contributed entry and copies it away from the overlay object', async () => {
    const source = {
      FixtureOverlayNote: { kind: 'holder', references: [{ ...ownerRef }] },
    } as ContributedDataHolderRegistry;
    const { DATA_HOLDER_REGISTRY } = await loadRegistry([source]);
    const entry = DATA_HOLDER_REGISTRY.FixtureOverlayNote as unknown as {
      kind: string;
      references: { action: string }[];
    };
    expect(entry).not.toBe(source.FixtureOverlayNote);
    expect(entry).toEqual(source.FixtureOverlayNote);
    expect(() => {
      entry.kind = 'noUserData';
    }).toThrow();
    expect(() => {
      entry.references.push({ action: 'x' });
    }).toThrow();
    expect(() => {
      entry.references[0].action = 'anonymize';
    }).toThrow();
    (source.FixtureOverlayNote as unknown as { references: { action: string }[] }).references[0].action = 'anonymize';
    expect(entry.references[0].action).toBe('deleteDocument');
  });

  describe('structure', () => {
    const child = { kind: 'viaParent', parent: 'FixtureParent', foreignKey: 'parentId' } as const;
    const validates = async (registries: unknown[]) => {
      const { assertContributedRegistryValid } = await loadRegistry(registries);
      assertContributedRegistryValid();
    };

    it('accepts a viaParent under a contributed holder', async () => {
      await expect(validates([{ FixtureParent: parentHolder, FixtureChild: child }])).resolves.toBeUndefined();
    });

    it('accepts a viaParent under a core holder', async () => {
      const entry = { kind: 'viaParent', parent: 'Annotation', foreignKey: 'parentId' };
      await expect(validates([{ FixtureChild: entry }])).resolves.toBeUndefined();
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
      [
        'exportScope on a non-retain reference',
        {
          FixtureScalarNote: {
            kind: 'holder',
            references: [{ path: 'ownerId', matchBy: 'userId', action: 'anonymize', exportScope: 'reference' }],
          },
        },
        /"FixtureScalarNote".*exportScope or identifies set on non-retain references: ownerId/,
      ],
      [
        'identifies on a non-retain reference',
        {
          FixtureScalarNote: {
            kind: 'holder',
            references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', identifies: ['label'] }],
          },
        },
        /"FixtureScalarNote".*exportScope or identifies set on non-retain references: ownerId/,
      ],
      [
        'a where value the schema does not allow',
        {
          FixtureKindNote: {
            kind: 'holder',
            references: [{ ...ownerRef, where: { kind: 'c' } }],
          },
        },
        /"FixtureKindNote".*where value rejected: FixtureKindNote.kind does not allow c/,
      ],
      [
        'a where value on a path with no enum',
        {
          FixtureKindNote: {
            kind: 'holder',
            references: [{ ...ownerRef, where: { label: 'x' } }],
          },
        },
        /"FixtureKindNote".*FixtureKindNote.label has no enum to check x against/,
      ],
      [
        'a personal-scoped reference with no unscoped anonymize',
        {
          FixtureOrgNote: {
            kind: 'holder',
            references: [{ ...ownerRef, scope: 'personal' }],
          },
        },
        /"FixtureOrgNote".*personal-scoped reference "ownerId" has no unscoped anonymize/,
      ],
    ])('rejects %s', async (_name, registry, message) => {
      await expect(validates([registry])).rejects.toThrow(message);
    });

    it('accepts a where value the schema allows and a personal scope with its fallback', async () => {
      const registry = {
        FixtureKindNote: { kind: 'holder', references: [{ ...ownerRef, where: { kind: 'a' } }] },
        FixtureOrgNote: {
          kind: 'holder',
          references: [
            { ...ownerRef, scope: 'personal' },
            { path: 'ownerId', matchBy: 'userId', action: 'anonymize' },
          ],
        },
      };
      await expect(validates([registry])).resolves.toBeUndefined();
    });

    it('accepts pullFromArray on an array path', async () => {
      const entry = {
        kind: 'holder',
        references: [{ path: 'members', matchBy: 'userId', action: 'pullFromArray' }],
      };
      await expect(validates([{ FixtureArrayNote: entry }])).resolves.toBeUndefined();
    });

    it('rejects a contributed model that is not registered with mongoose', async () => {
      await expect(validates([{ FixtureUnregistered: parentHolder }])).rejects.toThrow(
        /"FixtureUnregistered".*not a registered Mongoose model/
      );
    });
  });
});
