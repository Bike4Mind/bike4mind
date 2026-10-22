import { describe, it, expect } from 'vitest';
import {
  lakeOrderScopes,
  lakeScopeArms,
  orderFilesFairlyAcrossLakes,
  UNATTRIBUTED_LAKE_KEY,
  type LakeOrderScope,
} from './lakeFairOrder';

const file = (id: string, ...tags: string[]) => ({ id, tags });
const tagsOf = (f: { tags: string[] }) => f.tags;
const ids = (files: { id: string }[]) => files.map(f => f.id);

describe('lakeOrderScopes', () => {
  it('merges a meta-tag and a membership arm for the same lake into one bucket', () => {
    const scopes = lakeOrderScopes({
      dataLakeTags: ['datalake:a'],
      dataLakeTagPrefixes: [],
      lakeMemberships: [{ datalakeTag: 'datalake:a', fileTagPrefix: 'a:' }],
    });
    // One bucket, carrying both arms - two would give lake A a double share of the budget.
    expect(scopes).toEqual([{ key: 'datalake:a', datalakeTag: 'datalake:a', fileTagPrefix: 'a:' }]);
  });

  it('namespaces a registry prefix so it cannot collide with a meta-tag key', () => {
    const scopes = lakeOrderScopes({
      dataLakeTags: ['datalake:a'],
      dataLakeTagPrefixes: ['opti:'],
      lakeMemberships: [],
    });
    expect(scopes.map(s => s.key)).toEqual(['datalake:a', 'prefix:opti:']);
  });

  it('merges a registry lake tag and its open prefix into one bucket', () => {
    const scopes = lakeOrderScopes({
      dataLakeTags: ['datalake:reg', 'datalake:dyn'],
      dataLakeTagPrefixes: ['reg:'],
      lakeMemberships: [{ datalakeTag: 'datalake:dyn', fileTagPrefix: 'dyn:' }],
      lakes: [
        { datalakeTag: 'datalake:reg', fileTagPrefix: 'reg:' },
        { datalakeTag: 'datalake:dyn', fileTagPrefix: 'dyn:' },
      ],
    });
    expect(scopes).toEqual([
      { key: 'datalake:reg', datalakeTag: 'datalake:reg', registryPrefix: 'reg:' },
      { key: 'datalake:dyn', datalakeTag: 'datalake:dyn', fileTagPrefix: 'dyn:' },
    ]);
  });

  it('normalizes a null membership prefix rather than keying on it', () => {
    const scopes = lakeOrderScopes({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      lakeMemberships: [{ datalakeTag: 'datalake:b', fileTagPrefix: null }],
    });
    expect(scopes).toEqual([{ key: 'datalake:b', datalakeTag: 'datalake:b', fileTagPrefix: undefined }]);
  });

  it('skips a membership carrying neither arm instead of producing an empty key', () => {
    const scopes = lakeOrderScopes({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      lakeMemberships: [{ datalakeTag: null, fileTagPrefix: null }],
    });
    expect(scopes).toEqual([]);
  });
});

describe('lakeScopeArms', () => {
  it('partitions every arm of a mixed scope across its lake scopes, each arm exactly once', () => {
    const sources = {
      dataLakeTags: ['datalake:reg', 'datalake:dyn'],
      dataLakeTagPrefixes: ['reg:', 'orphan:'],
      lakeMemberships: [
        { datalakeTag: 'datalake:dyn', fileTagPrefix: 'dyn:' },
        { datalakeTag: null, fileTagPrefix: 'solo:' },
      ],
      lakes: [{ datalakeTag: 'datalake:reg', fileTagPrefix: 'reg:' }],
    };
    const scopes = lakeOrderScopes(sources);
    const slices = scopes.map(scope => lakeScopeArms(scope, sources));

    expect(slices.flatMap(s => s.dataLakeTags).sort()).toEqual([...sources.dataLakeTags].sort());
    expect(slices.flatMap(s => s.dataLakeTagPrefixes).sort()).toEqual([...sources.dataLakeTagPrefixes].sort());
    expect(slices.flatMap(s => s.lakeMemberships)).toEqual(sources.lakeMemberships);
    const reg = slices[scopes.findIndex(s => s.key === 'datalake:reg')];
    expect(reg).toEqual({ dataLakeTags: ['datalake:reg'], dataLakeTagPrefixes: ['reg:'], lakeMemberships: [] });
  });
});

describe('orderFilesFairlyAcrossLakes', () => {
  const scopes: LakeOrderScope[] = [
    { key: 'datalake:a', datalakeTag: 'datalake:a' },
    { key: 'datalake:b', datalakeTag: 'datalake:b' },
    { key: 'datalake:c', datalakeTag: 'datalake:c' },
  ];

  /**
   * The ticket's shape: two large lakes and one small one, arriving in a global filename sort that
   * puts the small lake last. Before the interleave, a sequential chunk budget spent on the head of
   * this order never reached lake C at all.
   */
  it('puts a small lake inside the head of the order rather than after both large ones', () => {
    const files = [
      file('a1', 'datalake:a'),
      file('a2', 'datalake:a'),
      file('a3', 'datalake:a'),
      file('b1', 'datalake:b'),
      file('b2', 'datalake:b'),
      file('b3', 'datalake:b'),
      file('c1', 'datalake:c'),
    ];
    const { ordered } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(ids(ordered)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'b3']);
    // The concrete acceptance property: C is reached within the first round, not at position 7.
    expect(ids(ordered).indexOf('c1')).toBeLessThan(3);
  });

  it('adding a lake changes the order the budget is spent in', () => {
    const ab = [file('a1', 'datalake:a'), file('a2', 'datalake:a'), file('b1', 'datalake:b')];
    const withoutC = orderFilesFairlyAcrossLakes(ab, scopes.slice(0, 2), tagsOf);
    const withC = orderFilesFairlyAcrossLakes([...ab, file('c1', 'datalake:c')], scopes, tagsOf);
    // The A+B vs A+B+C repro: the scanned prefix must differ, or C can contribute nothing.
    expect(ids(withC.ordered).slice(0, 3)).not.toEqual(ids(withoutC.ordered).slice(0, 3));
    expect(withC.filesByLake['datalake:c']).toBe(1);
  });

  it('preserves each lake relative order', () => {
    const files = [file('a1', 'datalake:a'), file('a2', 'datalake:a'), file('a3', 'datalake:a')];
    const { ordered } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(ids(ordered)).toEqual(['a1', 'a2', 'a3']);
  });

  it('is deterministic: the same inputs truncate at the same place', () => {
    const files = [file('b1', 'datalake:b'), file('a1', 'datalake:a'), file('c1', 'datalake:c')];
    const first = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    const second = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(ids(first.ordered)).toEqual(ids(second.ordered));
    // Bucket emission follows `scopes` order, not the order files happened to arrive in.
    expect(ids(first.ordered)).toEqual(['a1', 'b1', 'c1']);
  });

  it('charges a file tagged for several lakes to exactly one bucket', () => {
    const files = [file('both', 'datalake:a', 'datalake:b'), file('b1', 'datalake:b')];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(ids(ordered)).toEqual(['both', 'b1']);
    expect(filesByLake).toEqual({ 'datalake:a': 1, 'datalake:b': 1 });
  });

  it('attributes a registry file by its content-tag prefix, which carries no meta-tag', () => {
    const prefixScopes: LakeOrderScope[] = [{ key: 'prefix:opti:', fileTagPrefix: 'opti:' }, ...scopes];
    const files = [file('r1', 'opti:type:spec'), file('a1', 'datalake:a')];
    const { filesByLake } = orderFilesFairlyAcrossLakes(files, prefixScopes, tagsOf);
    expect(filesByLake).toEqual({ 'prefix:opti:': 1, 'datalake:a': 1 });
  });

  it('gives a registry lake one share however its files are tagged, next to a dynamic lake', () => {
    const regScopes = lakeOrderScopes({
      dataLakeTags: ['datalake:reg', 'datalake:dyn'],
      dataLakeTagPrefixes: ['reg:'],
      lakeMemberships: [],
      lakes: [{ datalakeTag: 'datalake:reg', fileTagPrefix: 'reg:' }],
    });
    // Registry files: two meta-tagged, two prefix-only. Dynamic lake: four files.
    const files = [
      file('r1', 'datalake:reg'),
      file('r2', 'datalake:reg'),
      file('r3', 'reg:x'),
      file('r4', 'reg:y'),
      file('d1', 'datalake:dyn'),
      file('d2', 'datalake:dyn'),
      file('d3', 'datalake:dyn'),
      file('d4', 'datalake:dyn'),
    ];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, regScopes, tagsOf);
    expect(filesByLake).toEqual({ 'datalake:reg': 4, 'datalake:dyn': 4 });
    expect(ids(ordered)).toEqual(['r1', 'd1', 'r2', 'd2', 'r3', 'd3', 'r4', 'd4']);
  });

  it('gives a membership-arm dynamic lake one share next to a paired registry lake', () => {
    const regScopes = lakeOrderScopes({
      dataLakeTags: ['datalake:reg', 'datalake:dyn'],
      dataLakeTagPrefixes: ['reg:'],
      lakeMemberships: [{ datalakeTag: 'datalake:dyn', fileTagPrefix: 'dyn:' }],
      lakes: [{ datalakeTag: 'datalake:reg', fileTagPrefix: 'reg:' }],
    });
    const files = [
      file('r1', 'datalake:reg'),
      file('r2', 'reg:x'),
      file('r3', 'reg:y'),
      file('d1', 'dyn:x'),
      file('d2', 'datalake:dyn'),
      file('d3', 'dyn:y'),
    ];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, regScopes, tagsOf);
    expect(filesByLake).toEqual({ 'datalake:reg': 3, 'datalake:dyn': 3 });
    expect(ids(ordered)).toEqual(['r1', 'd1', 'r2', 'd2', 'r3', 'd3']);
  });

  it('keeps a file meta-tagged into a dynamic lake in that lake even when it also carries a registry prefix', () => {
    const regScopes = lakeOrderScopes({
      dataLakeTags: ['datalake:reg', 'datalake:dyn'],
      dataLakeTagPrefixes: ['reg:'],
      lakeMemberships: [],
      lakes: [{ datalakeTag: 'datalake:reg', fileTagPrefix: 'reg:' }],
    });
    const files = [{ id: 'both', tags: ['reg:x', 'datalake:dyn'] }, file('d1', 'datalake:dyn')];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, regScopes, tagsOf);
    expect(filesByLake).toEqual({ 'datalake:dyn': 2 });
    expect(ids(ordered)).toEqual(['both', 'd1']);
  });

  it('keeps the prefix key when two lakes carry the same registry prefix', () => {
    const lakes = [
      { datalakeTag: 'datalake:dyn', fileTagPrefix: 'opti:' },
      { datalakeTag: 'datalake:reg', fileTagPrefix: 'opti:' },
    ];
    const dupScopes = lakeOrderScopes({
      dataLakeTags: ['datalake:dyn', 'datalake:reg'],
      dataLakeTagPrefixes: ['opti:'],
      lakeMemberships: [],
      lakes,
    });
    const { filesByLake } = orderFilesFairlyAcrossLakes([file('p1', 'opti:x')], dupScopes, tagsOf);
    expect(filesByLake).toEqual({ 'prefix:opti:': 1 });
  });

  it('charges a file with two registry prefixes to the lake first in dataLakeTags order', () => {
    const twoScopes = lakeOrderScopes({
      dataLakeTags: ['datalake:b', 'datalake:a'],
      dataLakeTagPrefixes: ['a:', 'b:'],
      lakeMemberships: [],
      lakes: [
        { datalakeTag: 'datalake:a', fileTagPrefix: 'a:' },
        { datalakeTag: 'datalake:b', fileTagPrefix: 'b:' },
      ],
    });
    const { filesByLake } = orderFilesFairlyAcrossLakes([file('x', 'a:x', 'b:y')], twoScopes, tagsOf);
    expect(filesByLake).toEqual({ 'datalake:b': 1 });
  });

  it('gives own/shared files their own bucket instead of starving them', () => {
    const files = [file('own1'), file('own2'), file('a1', 'datalake:a')];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(filesByLake[UNATTRIBUTED_LAKE_KEY]).toBe(2);
    // Round one covers the lake and the unattributed bucket alike.
    expect(ids(ordered)).toEqual(['a1', 'own1', 'own2']);
  });

  it('omits a scoped lake that contributed no file, which is the telemetry signal', () => {
    const files = [file('a1', 'datalake:a')];
    const { filesByLake } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(filesByLake).toEqual({ 'datalake:a': 1 });
    expect(filesByLake['datalake:c']).toBeUndefined();
  });

  it('reorders without filtering: every scoped file survives', () => {
    const files = [file('a1', 'datalake:a'), file('b1', 'datalake:b'), file('own')];
    const { ordered } = orderFilesFairlyAcrossLakes(files, scopes, tagsOf);
    expect(ids(ordered).sort()).toEqual(['a1', 'b1', 'own']);
  });

  it('handles an empty scope list by leaving the order alone', () => {
    const files = [file('a1', 'datalake:a'), file('b1', 'datalake:b')];
    const { ordered, filesByLake } = orderFilesFairlyAcrossLakes(files, [], tagsOf);
    expect(ids(ordered)).toEqual(['a1', 'b1']);
    expect(filesByLake).toEqual({ [UNATTRIBUTED_LAKE_KEY]: 2 });
  });
});
