import {
  CATALOG_SCHEMA_VERSION,
  ImageModels,
  ModelBackend,
  groupsTouchedByPatch,
  toModelRecord,
  type BFLImageModel,
  type IModelCatalogRow,
  type IModelCatalogRowInput,
  type ModelInfo,
} from '@bike4mind/common';
import { BFLBackend, resolveCatalogRecords } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { FluxImageCostCalculator } from '../llm/imageCostCalculator/FluxImageCostCalculator';
import { testCredentials } from './__fixtures__/fakes';
import { planCatalogWrites } from './catalogWrite';
import { normalizeBflOpenApi } from './sources/bfl';
import openapi from './sources/__fixtures__/bfl/openapi.json';

/**
 * Every FLUX.2 endpoint BFL lists is discovered, so the adapter table - not the endpoint list -
 * is what decides whether it becomes a product. Without a curated entry the endpoint is
 * introduced under its slug, with no description and no price, and left auto-disabled; with one
 * it arrives named, described and priced. The drop assertion is the stated acceptance criterion,
 * but it passes either way (discovery falls back to the slug for non-OpenAI backends), so the
 * named-and-enabled half is the one that would have caught the defect.
 */
const RUN_AT = new Date('2026-10-23T10:00:00Z');
const SEED_AT = new Date('2026-01-01T00:00:00Z');

const FLUX_2_IDS: BFLImageModel[] = [
  ImageModels.FLUX_2_MAX,
  ImageModels.FLUX_2_PRO,
  ImageModels.FLUX_2_PRO_PREVIEW,
  ImageModels.FLUX_2_FLEX,
  ImageModels.FLUX_2_KLEIN_9B,
  ImageModels.FLUX_2_KLEIN_9B_PREVIEW,
  ImageModels.FLUX_2_KLEIN_4B,
];

const bflTable = async (): Promise<ModelInfo[]> => new BFLBackend('test-key').getModelInfo();

/** The catalog a fresh install has after seeding: the adapter literal, as seed rows. */
const seedRows = async (): Promise<IModelCatalogRow[]> =>
  (await bflTable()).map(model => {
    const patch = toModelRecord(model);
    return {
      modelId: String(model.id),
      schemaVersion: CATALOG_SCHEMA_VERSION,
      source: 'seed',
      ownedGroups: groupsTouchedByPatch(patch as unknown as Record<string, unknown>),
      patch,
      effectiveFrom: SEED_AT,
    } as unknown as IModelCatalogRow;
  });

const asRow = (row: IModelCatalogRowInput): IModelCatalogRow =>
  ({ ...row, effectiveFrom: RUN_AT }) as unknown as IModelCatalogRow;

describe('FLUX.2 curated catalog entries', () => {
  it('curates every FLUX.2 endpoint the discovery fixture lists', async () => {
    const listed = normalizeBflOpenApi(openapi)
      .map(record => record.modelId)
      .filter(modelId => modelId.startsWith('flux-2-'));
    const curated = new Set((await bflTable()).map(model => String(model.id)));

    expect(listed.sort()).toEqual([...FLUX_2_IDS].sort());
    expect(listed.filter(modelId => !curated.has(modelId))).toEqual([]);
  });

  it.each(FLUX_2_IDS)('gives %s a name, a description, capabilities and a price', async id => {
    const entry = (await bflTable()).find(model => model.id === id);

    expect(entry, `${id} is missing from the BFL adapter table`).toBeDefined();
    expect(entry!.name).toBeTruthy();
    expect(entry!.name).not.toBe(id);
    const escapedName = entry!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(entry!.description).toMatch(new RegExp(`^${escapedName} - \\S`));
    expect(entry!.supportsImageVariation).toBe(true);
    expect(entry!.supportsSafetyTolerance).toBe(true);
    expect(new FluxImageCostCalculator().getCost({ model: id })).toBeGreaterThan(0);
  });
});

describe('BFL discovery over the curated table', () => {
  const plan = async () =>
    planCatalogWrites({
      contributions: [{ name: 'bfl', kind: 'provider', records: normalizeBflOpenApi(openapi) }],
      base: resolveCatalogRecords(await seedRows()),
      coveredBackends: new Set<string>([ModelBackend.BFL]),
      operatorOwnedModelIds: new Set(),
      credentials: testCredentials(),
      policy: 'priced',
      runStartedAt: RUN_AT,
      runId: 'run-flux2',
    });

  it('drops no FLUX.2 endpoint', async () => {
    const { dropped } = await plan();

    expect(dropped.filter(record => FLUX_2_IDS.includes(record.modelId as BFLImageModel))).toEqual([]);
  });

  it('leaves every FLUX.2 row named, described and not auto-disabled', async () => {
    const { rows } = await plan();
    // The read path: this run's rows layered over the seeded ones.
    const after = resolveCatalogRecords([...(await seedRows()), ...rows.map(asRow)]);

    for (const id of FLUX_2_IDS) {
      const record = after.get(id)?.record;
      expect(record, `${id} has no catalog row`).toBeDefined();
      expect(record!.name, `${id} is carried as its slug`).not.toBe(id);
      expect(record!.description, `${id} has no description`).toBeTruthy();
      expect(record!.autoDisabled, `${id} was auto-disabled despite being curated`).toBeFalsy();
    }
  });
});
