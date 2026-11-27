import { describe, expect, it } from 'vitest';
import {
  CALLABLE_FUNCTION_PROTECTED_FIELDS,
  CALLABLE_FUNCTION_SLUG_PATTERN,
  CallableFunctionGrantVisibilitySchema,
  callableFunctionTrustLabel,
  effectiveCallableFunctionStatus,
  toCallableFunctionDetail,
  toCallableFunctionPublic,
  toCallableFunctionShared,
  type ICallableFunctionDocument,
} from './CallableFunctionTypes';
import type { FunctionContract } from '../../schemas/functionContract';

const contract: FunctionContract = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: { type: 'object', additionalProperties: false, properties: { span: { type: 'number', unit: 'm' } } },
  outputs: { type: 'object', additionalProperties: false, properties: { deflection: { type: 'number', unit: 'm' } } },
};

const doc = (overrides: Partial<ICallableFunctionDocument> = {}): ICallableFunctionDocument => ({
  id: '6650f0a1b2c3d4e5f6a7b8c9',
  ownerType: 'user',
  ownerKey: 'user-1',
  userId: 'user-1',
  slug: 'beam_midspan_deflection',
  description: contract.description,
  state: 'draft',
  enabled: true,
  pin: {
    artifactId: 'artifact-1',
    version: 2,
    contentHash: 'a'.repeat(64),
    source: 'FUNCTION = {}\ndef run():\n    return {}',
    pinnedAt: new Date('2026-01-01T00:00:00Z'),
  },
  contract,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  ...overrides,
});

describe('CALLABLE_FUNCTION_SLUG_PATTERN', () => {
  it.each(['beam_midspan_deflection', 'ab', 'a1', 'x2_y3', 'a'.repeat(40)])('takes %s', slug => {
    expect(CALLABLE_FUNCTION_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each(['a__b', 'a_', 'Ab', 'a', '_a', '1a', 'a-b', 'a'.repeat(41)])('refuses %s', slug => {
    expect(CALLABLE_FUNCTION_SLUG_PATTERN.test(slug)).toBe(false);
  });
});

describe('effectiveCallableFunctionStatus', () => {
  const head = { version: 2, deletedAt: null };

  it('is disabled when turned off and the artifact is still there', () => {
    expect(effectiveCallableFunctionStatus({ enabled: false, state: 'draft' }, head)).toBe('disabled');
    expect(effectiveCallableFunctionStatus({ enabled: false, state: 'live' }, head)).toBe('disabled');
  });

  it('is source_deleted when the artifact is gone or soft-deleted, turned off or not', () => {
    expect(effectiveCallableFunctionStatus({ enabled: true, state: 'draft' }, null)).toBe('source_deleted');
    expect(effectiveCallableFunctionStatus({ enabled: false, state: 'draft' }, null)).toBe('source_deleted');
    expect(
      effectiveCallableFunctionStatus({ enabled: true, state: 'live' }, { version: 2, deletedAt: new Date() })
    ).toBe('source_deleted');
    expect(
      effectiveCallableFunctionStatus({ enabled: false, state: 'live' }, { version: 2, deletedAt: new Date() })
    ).toBe('source_deleted');
  });

  it('is the stored state otherwise', () => {
    expect(effectiveCallableFunctionStatus({ enabled: true, state: 'draft' }, head)).toBe('draft');
    expect(effectiveCallableFunctionStatus({ enabled: true, state: 'live' }, head)).toBe('live');
  });
});

describe('toCallableFunctionPublic', () => {
  it('names only the allowlisted fields: no code, contract, or owner fields', () => {
    const view = toCallableFunctionPublic(doc(), { version: 2 });
    expect(Object.keys(view).sort()).toEqual(
      [
        'approval',
        'createdAt',
        'dataPins',
        'description',
        'enabled',
        'examples',
        'grants',
        'id',
        'latestVersion',
        'pin',
        'slug',
        'sources',
        'state',
        'status',
        'trustLabel',
        'updateAvailable',
        'updatedAt',
      ].sort()
    );
    expect(Object.keys(view.pin).sort()).toEqual(['artifactId', 'contentHash', 'pinnedAt', 'version']);
    expect(JSON.stringify(view)).not.toContain('def run');
  });

  it('shows the label and the promotion sequence only while live, and never the server run or runtime', () => {
    const promoted = {
      trustLabel: 'verified' as const,
      lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
      pin: { ...doc().pin, seq: 2, runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] } },
    };
    const live = toCallableFunctionPublic(doc({ ...promoted, state: 'live' }), { version: 2 });
    expect(live).toMatchObject({ trustLabel: 'verified', pin: { seq: 2 } });
    expect(live).not.toHaveProperty('lastServerRun');
    expect(live.pin).not.toHaveProperty('runtime');
    expect(toCallableFunctionPublic(doc({ ...promoted, state: 'draft' }), { version: 2 }).trustLabel).toBeNull();
  });

  it('reports a newer artifact version as an available update', () => {
    expect(toCallableFunctionPublic(doc(), { version: 3 })).toMatchObject({
      status: 'draft',
      latestVersion: 3,
      updateAvailable: true,
    });
    expect(toCallableFunctionPublic(doc(), { version: 2 })).toMatchObject({ latestVersion: 2, updateAvailable: false });
  });

  it('offers no update for a deleted artifact and no version for a missing one', () => {
    expect(toCallableFunctionPublic(doc(), { version: 5, deletedAt: new Date() })).toMatchObject({
      status: 'source_deleted',
      latestVersion: 5,
      updateAvailable: false,
    });
    expect(toCallableFunctionPublic(doc(), null)).toMatchObject({
      status: 'source_deleted',
      latestVersion: null,
      updateAvailable: false,
    });
  });
});

describe('sharing', () => {
  const grants = {
    visibility: 'project' as const,
    projectId: 'project-1',
    userIds: ['user-2'],
  };

  it('shows the owner the grants', () => {
    expect(toCallableFunctionPublic(doc(), { version: 2 }).grants).toBeNull();
    expect(toCallableFunctionPublic(doc({ grants }), { version: 2 }).grants).toEqual(grants);
  });

  const hash = 'a'.repeat(64);
  const review = {
    functionId: 'fn-1',
    userId: 'user-2',
    reviewHash: hash,
    approval: 'always_ask' as const,
    enabled: true,
    reviewedAt: new Date(),
  };
  const shared = (reviewed: typeof review | null) =>
    toCallableFunctionShared(
      doc({
        state: 'live',
        trustLabel: 'verified',
        grants,
        pin: { ...doc().pin, seq: 2 },
        contract: { ...contract, tests: [{ name: 'secret case', input: {}, expected: {} }] },
      }),
      'project',
      { ownerName: 'Owner Name', reviewHash: hash, review: reviewed }
    );

  it('shows a recipient the interface but no code, tests, artifact, examples, grants, or owner ids', () => {
    const view = shared(null);
    expect(Object.keys(view).sort()).toEqual(
      [
        'dataPins',
        'description',
        'id',
        'inputs',
        'outputs',
        'ownerName',
        'pin',
        'review',
        'reviewHash',
        'sharedVia',
        'slug',
        'sources',
        'status',
        'trustLabel',
        'updatedAt',
      ].sort()
    );
    expect(Object.keys(view.pin).sort()).toEqual(['pinnedAt', 'seq', 'version']);
    expect(view).toMatchObject({ status: 'pending_review', sharedVia: 'project', trustLabel: 'verified' });
    expect(view.inputs).toEqual(contract.inputs);
    expect(JSON.stringify(view)).not.toMatch(/def run|artifact-1|user-2|secret case/);
  });

  it('names the pinned data files and nothing else about them', () => {
    const dataPin = {
      name: 'points.csv',
      sha256: 'c'.repeat(64),
      bytes: 12,
      sourceFileId: 'file-1',
      pinnedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const view = toCallableFunctionShared(
      doc({ state: 'live', pin: { ...doc().pin, dataPins: [dataPin] } }),
      'project',
      { ownerName: 'Owner Name', reviewHash: hash, review: null }
    );
    expect(view.dataPins).toEqual(['points.csv']);
    expect(JSON.stringify(view)).not.toMatch(/c{64}|file-1/);
    expect(shared(null).dataPins).toEqual([]);
  });

  it('names the live and pinned sources and never their URLs', () => {
    const view = toCallableFunctionShared(
      doc({
        state: 'live',
        sources: [
          { name: 'rates.csv', url: 'https://data.example.com/private/rates.csv', mode: 'live' },
          { name: 'base.csv', url: 'https://data.example.com/private/base.csv', mode: 'pinned' },
        ],
      }),
      'project',
      { ownerName: 'Owner Name', reviewHash: hash, review: null }
    );
    expect(view.sources).toEqual(['rates.csv', 'base.csv']);
    expect(JSON.stringify(view)).not.toMatch(/data\.example\.com|private/);
    expect(shared(null).sources).toEqual([]);
  });

  it('reads reviewed only while the review names the current hash and is on', () => {
    expect(shared(review)).toMatchObject({ status: 'reviewed', review: { approval: 'always_ask', current: true } });
    expect(shared({ ...review, enabled: false }).status).toBe('disabled');
    const stale = shared({ ...review, reviewHash: 'b'.repeat(64), enabled: false });
    expect(stale).toMatchObject({ status: 'pending_review', review: { current: false } });
  });

  it('has no public rung and protects the grants', () => {
    expect(CallableFunctionGrantVisibilitySchema.options).toEqual(['private', 'project', 'organization']);
    expect(CALLABLE_FUNCTION_PROTECTED_FIELDS).toContain('grants');
  });
});

describe('toCallableFunctionDetail', () => {
  it('adds the contract and the pinned code, still without owner fields', () => {
    const detail = toCallableFunctionDetail(doc(), { version: 2 });
    expect(detail.contract).toEqual(contract);
    expect(detail.source).toBe(doc().pin.source);
    expect(detail).not.toHaveProperty('ownerKey');
    expect(detail).not.toHaveProperty('userId');
    expect(detail.pin).not.toHaveProperty('source');
  });
});

describe('callableFunctionTrustLabel', () => {
  it('is verified only when a worked example passed', () => {
    expect(callableFunctionTrustLabel([{ kind: 'example', passed: true }])).toBe('verified');
    expect(
      callableFunctionTrustLabel([
        { kind: 'test', passed: true },
        { kind: 'example', passed: true },
      ])
    ).toBe('verified');
  });

  it('is unverified with declared tests only, with no cases, or with no passing example', () => {
    expect(callableFunctionTrustLabel([{ kind: 'test', passed: true }])).toBe('unverified');
    expect(callableFunctionTrustLabel([])).toBe('unverified');
    expect(callableFunctionTrustLabel([{ kind: 'example', passed: false }])).toBe('unverified');
  });
});
