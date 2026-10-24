import {
  BFL_IMAGE_MODELS,
  CATALOG_SCHEMA_VERSION,
  ImageModels,
  ModelBackend,
  groupsTouchedByPatch,
  toModelRecord,
  type BFLImageModel,
  type IModelCatalogRow,
  type ModelInfo,
} from '@bike4mind/common';
import { BFLBackend, mergeCatalogWithDrops, resolveCatalogRecords } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { FluxImageCostCalculator, type FluxModel } from '../llm/imageCostCalculator/FluxImageCostCalculator';
import { testCredentials } from './__fixtures__/fakes';
import { planCatalogWrites } from './catalogWrite';
import { discoveryContributorsInForce, discoveryGroupsInForce } from './runModelDiscovery';
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
/** Before the curated adapter table existed: when discovery introduced the endpoints. */
const INTRODUCED_AT = new Date('2026-09-01T00:00:00Z');

const BFL_KEYS = { apiKeys: { bfl: 'test-key' }, isSelfHost: false, bedrockReachable: false };

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

/**
 * The feed as the build before this branch read it: it also reported `contextWindow: 0` and spelled
 * the vendor 'bfl'. Both are what made the row it introduced claim `limits` at 0 and what makes the
 * first run after the upgrade plan a vendor correction. Rebuilt from the current parser so the row
 * under test is still the one the writer produces, not a hand-written approximation.
 */
const preCurationFeed = (): ReturnType<typeof normalizeBflOpenApi> =>
  normalizeBflOpenApi(openapi).map(record => ({
    ...record,
    patch: { ...record.patch, vendor: 'bfl', contextWindow: 0 },
  }));

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

describe('curated adapter table invariants', () => {
  // The adapter table and BFL_IMAGE_MODELS are two hand-maintained lists, and curation is what
  // makes an endpoint a product. An id in one but not the other still passes discovery, then
  // fails at credit pre-flight, where isBflImageModel is false and ImageGeneration throws
  // "Model not supported" (and dispatch would route it to the OpenAI service).
  it('makes every curated model a dispatchable, positively priced BFL id', async () => {
    const calculator = new FluxImageCostCalculator();

    for (const model of await bflTable()) {
      expect(BFL_IMAGE_MODELS, `${model.id} is curated but absent from BFL_IMAGE_MODELS`).toContain(model.id);
      expect(calculator.getCost({ model: model.id as FluxModel }), `${model.id} has no price`).toBeGreaterThan(0);
    }
  });
});

describe('BFL discovery over the curated table', () => {
  /** The plan once the curated table is seeded: the state every deployment reaches after upgrade. */
  const curatedPlan = async () =>
    planCatalogWrites({
      contributions: [{ name: 'bfl', kind: 'provider', records: normalizeBflOpenApi(openapi) }],
      base: resolveCatalogRecords(await seedRows()),
      coveredBackends: new Set<string>([ModelBackend.BFL]),
      providerSourceNames: new Set(['bfl']),
      operatorOwnedModelIds: new Set(),
      credentials: testCredentials(),
      policy: 'priced',
      runStartedAt: RUN_AT,
      runId: 'run-flux2',
    });

  // The plan's own output, because everything below it is satisfied by seedRows() alone whether
  // or not this run saw a single FLUX.2 record.
  it('sights every FLUX.2 endpoint and drops none', async () => {
    const { sightedModelIds, dropped } = await curatedPlan();

    expect(
      FLUX_2_IDS.filter(id => sightedModelIds.has(id)),
      'discovery no longer reports a FLUX.2 endpoint'
    ).toEqual(FLUX_2_IDS);
    expect(dropped.filter(record => FLUX_2_IDS.includes(record.modelId as BFLImageModel))).toEqual([]);
  });

  it('proposes no change to a model the curated table already describes', async () => {
    const { rows, sightedModelIds } = await curatedPlan();

    // Guard the guard: a feed that emitted no FLUX.2 record would satisfy the assertion below
    // vacuously, and so would a build that dropped them all before the plan saw them.
    expect(FLUX_2_IDS.filter(id => sightedModelIds.has(id))).toEqual(FLUX_2_IDS);
    expect(rows.filter(record => FLUX_2_IDS.includes(record.modelId as BFLImageModel))).toEqual([]);
  });
});

describe('a catalog discovery reached before the adapter table curated it', () => {
  /**
   * The row the pre-change build wrote for every endpoint the moment BFL listed it: its slug for
   * a name, contextWindow 0, autoDisabled and status 'discovered'. Planned from an empty catalog
   * by the writer itself rather than hand-written, fed the facts that build read - it still
   * reported the 0, which is what made its row claim `limits`.
   */
  const introducedRows = async (): Promise<IModelCatalogRow[]> => {
    const { rows } = planCatalogWrites({
      contributions: [{ name: 'bfl', kind: 'provider', records: preCurationFeed() }],
      base: new Map(),
      coveredBackends: new Set<string>([ModelBackend.BFL]),
      providerSourceNames: new Set(['bfl']),
      operatorOwnedModelIds: new Set(),
      credentials: testCredentials(),
      policy: 'priced',
      runStartedAt: INTRODUCED_AT,
      runId: 'run-before-curation',
    });
    return rows.map(row => ({ ...row, effectiveFrom: INTRODUCED_AT }) as unknown as IModelCatalogRow);
  };

  const render = async (rows: IModelCatalogRow[]) => mergeCatalogWithDrops(await bflTable(), rows, BFL_KEYS);

  const flux2Of = ({ models }: { models: ModelInfo[] }) =>
    models.filter(model => FLUX_2_IDS.includes(model.id as BFLImageModel));

  /** The scheduled run after the upgrade: planning against the catalog the deployed build left. */
  const nextRun = async (rows: IModelCatalogRow[]): Promise<IModelCatalogRow[]> => {
    const { rows: planned } = planCatalogWrites({
      contributions: [{ name: 'bfl', kind: 'provider', records: normalizeBflOpenApi(openapi) }],
      base: resolveCatalogRecords(rows),
      // What production hands the plan, so the correction rows re-claim what the superseded
      // discovery row owned rather than what this run happened to observe.
      priorDiscoveryGroups: discoveryGroupsInForce(rows),
      priorContributors: discoveryContributorsInForce(rows),
      coveredBackends: new Set<string>([ModelBackend.BFL]),
      providerSourceNames: new Set(['bfl']),
      operatorOwnedModelIds: new Set(),
      credentials: testCredentials(),
      policy: 'priced',
      runStartedAt: RUN_AT,
      runId: 'run-after-upgrade',
    });
    return planned.map(row => ({ ...row, effectiveFrom: RUN_AT }) as unknown as IModelCatalogRow);
  };

  const expectCurated = async (rows: IModelCatalogRow[]) => {
    const literal = await bflTable();
    const { models, dropped } = await render(rows);

    // Only the endpoints nobody curated are withheld; every curated one must render.
    expect(dropped.filter(record => FLUX_2_IDS.includes(record.modelId as BFLImageModel))).toEqual([]);
    for (const id of FLUX_2_IDS) {
      const curated = literal.find(model => model.id === id)!;
      const model = models.find(candidate => String(candidate.id) === id);

      expect(model, `${id} is missing from the merged models`).toBeDefined();
      expect(model!.name, `${id} is still carried as its slug`).toBe(curated.name);
      expect(model!.contextWindow, `${id} lost its curated context window`).toBe(curated.contextWindow);
      expect(model!.description).toBe(curated.description);
      expect(model!.disabled, `${id} is still auto-disabled after curation`).toBeFalsy();
      expect(model!.disabledReason).toBeUndefined();
    }
  };

  it('introduces them under their slug, disabled, so the upgrade starts from a real row', async () => {
    const introduced = await introducedRows();

    for (const id of FLUX_2_IDS) {
      const row = introduced.find(candidate => candidate.modelId === id);
      expect(row?.patch, `${id} was not introduced`).toMatchObject({ name: id, contextWindow: 0, autoDisabled: true });
      expect(row?.ownedGroups, `${id}'s introduction claimed no limits`).toContain('limits');
      expect(row?.patch.lifecycle?.status).toBe('discovered');
    }
  });

  it('renders the curated model over the row that introduced it', async () => {
    await expectCurated([...(await introducedRows()), ...(await seedRows())]);
  });

  it('renders that deployment exactly as a fresh one', async () => {
    const fresh = await render(await seedRows());
    const upgraded = await render([...(await introducedRows()), ...(await seedRows())]);

    expect(flux2Of(upgraded)).toEqual(flux2Of(fresh));
  });

  it('keeps the curated record after the next discovery run snapshots over it', async () => {
    const upgraded = [...(await introducedRows()), ...(await seedRows())];
    const planned = await nextRun(upgraded);

    // Pin the rows this run plans for the endpoints. `planned.length > 0` is satisfied by the five
    // non-FLUX.2 vendor corrections alone, and the render below would not notice their absence.
    const plannedFlux2 = planned.filter(record => FLUX_2_IDS.includes(record.modelId as BFLImageModel));
    expect(plannedFlux2.map(record => record.modelId).sort()).toEqual([...FLUX_2_IDS].sort());
    for (const record of plannedFlux2) {
      // Still an introduction: the slug it pinned and discovery's own disable, carried forward.
      expect(record.patch, `${record.modelId}'s snapshot stopped being a placeholder`).toMatchObject({
        name: record.modelId,
        autoDisabled: true,
      });
      // The groups production re-claims from the row this snapshot supersedes, not just this run's.
      expect(record.ownedGroups, `${record.modelId} lost the superseded row's claims`).toEqual(
        expect.arrayContaining(['lifecycle', 'availability'])
      );
    }

    const before = await render(upgraded);
    const after = await render([...upgraded, ...planned]);
    expect(flux2Of(after), 'the snapshot changed what the picker serves').toEqual(flux2Of(before));

    await expectCurated([...upgraded, ...planned]);
  });
});
