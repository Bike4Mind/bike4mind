import { describe, it, expect } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  FIELD_GROUPS,
  FIELD_GROUP_OF,
  MODEL_INFO_FIELDS_NOT_IN_CATALOG,
  MODEL_INFO_FIELD_GROUP_OF,
  ModelCatalogRowInput,
  ModelCatalogRowRead,
  ModelRecordWrite,
  groupsTouchedByPatch,
} from './ModelCatalogTypes';
import { ModelBackend } from '../../models';

const minimalRecord = {
  id: 'gpt-x',
  vendor: 'openai',
  backend: ModelBackend.OpenAI,
  type: 'text' as const,
  name: 'GPT X',
  contextWindow: 128_000,
};

const snapshotRow = {
  modelId: 'gpt-x',
  source: 'discovery' as const,
  ownedGroups: ['identity' as const, 'limits' as const],
  patch: minimalRecord,
  effectiveFrom: new Date('2026-07-01T00:00:00Z'),
};

describe('field groups', () => {
  // Object.keys of the write schema is the runtime spelling of `keyof ModelRecord`:
  // adding a field without grouping it fails here as well as at compile time.
  const recordFields = Object.keys(ModelRecordWrite.shape);

  it('assigns every ModelRecord field to exactly one group', () => {
    expect(recordFields.sort()).toEqual(Object.keys(FIELD_GROUP_OF).sort());
  });

  it('only assigns groups from the closed union', () => {
    for (const group of Object.values(FIELD_GROUP_OF)) {
      expect(FIELD_GROUPS).toContain(group);
    }
    for (const group of Object.values(MODEL_INFO_FIELD_GROUP_OF)) {
      expect(FIELD_GROUPS).toContain(group);
    }
  });

  it('routes every ModelInfo field to a group except the ones no catalog row may carry', () => {
    for (const field of MODEL_INFO_FIELDS_NOT_IN_CATALOG) {
      expect(MODEL_INFO_FIELD_GROUP_OF).not.toHaveProperty(field);
    }
    expect(MODEL_INFO_FIELDS_NOT_IN_CATALOG).toContain('pricing');
  });

  it('reports the groups a patch touches and ignores fields it does not know', () => {
    expect(groupsTouchedByPatch({ rank: 3, contextWindow: 1000 }).sort()).toEqual(['limits', 'presentation']);
    expect(groupsTouchedByPatch({ somethingFromAFutureVersion: true })).toEqual([]);
  });
});

describe('ModelRecordWrite', () => {
  it('accepts a record carrying only the required fields', () => {
    expect(ModelRecordWrite.parse(minimalRecord)).toMatchObject({ id: 'gpt-x', contextWindow: 128_000 });
  });

  it('rejects a pricing key: prices belong to ModelPrice and would be discarded here', () => {
    expect(() => ModelRecordWrite.parse({ ...minimalRecord, pricing: { '0': { input: 1, output: 2 } } })).toThrow();
  });

  it('rejects a fixed temperature mode with no temperature to send', () => {
    expect(() => ModelRecordWrite.parse({ ...minimalRecord, temperatureMode: 'fixed' })).toThrow(/fixedTemperature/);
    expect(ModelRecordWrite.parse({ ...minimalRecord, temperatureMode: 'fixed', fixedTemperature: 1 })).toMatchObject({
      fixedTemperature: 1,
    });
  });

  it('rejects a malformed calendar date', () => {
    expect(() => ModelRecordWrite.parse({ ...minimalRecord, releaseDate: '2026-7-1' })).toThrow();
  });
});

describe('ModelCatalogRowInput', () => {
  it('accepts a discovery snapshot row', () => {
    expect(ModelCatalogRowInput.parse(snapshotRow)).toMatchObject({ modelId: 'gpt-x', source: 'discovery' });
  });

  it('rejects a row claiming a group its patch does not touch', () => {
    expect(() => ModelCatalogRowInput.parse({ ...snapshotRow, ownedGroups: ['identity', 'dispatch'] })).toThrow(
      /dispatch/
    );
  });

  it('requires a note on operator rows', () => {
    const operatorRow = {
      modelId: 'gpt-x',
      source: 'operator' as const,
      ownedGroups: ['presentation' as const],
      patch: { rank: 1 },
      effectiveFrom: new Date('2026-07-02T00:00:00Z'),
    };
    expect(() => ModelCatalogRowInput.parse(operatorRow)).toThrow();
    expect(ModelCatalogRowInput.parse({ ...operatorRow, note: 'pinned for the launch demo' })).toMatchObject({
      note: 'pinned for the launch demo',
    });
  });

  it('rejects an operator row that changes nothing', () => {
    expect(() =>
      ModelCatalogRowInput.parse({
        modelId: 'gpt-x',
        source: 'operator',
        ownedGroups: ['presentation'],
        patch: {},
        note: 'why',
        effectiveFrom: new Date(),
      })
    ).toThrow();
  });

  it('requires a whole record on seed and discovery rows', () => {
    expect(() => ModelCatalogRowInput.parse({ ...snapshotRow, patch: { rank: 2 } })).toThrow();
  });
});

describe('ModelCatalogRowRead', () => {
  const storedRow = {
    modelId: 'gpt-x',
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'discovery',
    ownedGroups: ['identity'],
    patch: minimalRecord,
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
  };

  it('passes through fields a later schema version added', () => {
    const parsed = ModelCatalogRowRead.parse({
      ...storedRow,
      schemaVersion: CATALOG_SCHEMA_VERSION + 1,
      patch: { ...minimalRecord, quantizationProfile: 'q8' },
      provenanceV2: 'kept',
    });
    expect(parsed.patch).toMatchObject({ quantizationProfile: 'q8' });
    expect(parsed).toMatchObject({ provenanceV2: 'kept' });
  });

  it('accepts enum values this build does not know, so the merge can drop and count them', () => {
    const parsed = ModelCatalogRowRead.parse({
      ...storedRow,
      source: 'import',
      ownedGroups: ['identity', 'holography'],
      patch: { ...minimalRecord, type: 'holograph', adapterFamily: 'holo-messages' },
    });
    expect(parsed.patch.type).toBe('holograph');
  });

  it('still rejects a structurally corrupt row', () => {
    expect(
      ModelCatalogRowRead.safeParse({ ...storedRow, patch: { ...minimalRecord, contextWindow: 'lots' } }).success
    ).toBe(false);
  });
});
