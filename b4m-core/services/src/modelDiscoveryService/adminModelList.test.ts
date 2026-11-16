import {
  CATALOG_SCHEMA_VERSION,
  ModelBackend,
  type IModelCatalogRow,
  type IModelPrice,
  type LLMModelConfig,
  type ModelInfo,
} from '@bike4mind/common';
import { REALTIME_VOICE_PRICING, staticAdapterModels } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import {
  FakeAdminSettingsRepository,
  FakeCacheRepository,
  FakeCatalogRepository,
  FakeDiscoveryStateRepository,
  FakePriceRepository,
  FakeRunRepository,
  stubSource,
  testCredentials,
} from './__fixtures__/fakes';
import {
  adminModelListPage,
  adminReasonsFromDisableText,
  buildAdminModelRows,
  filterAdminModels,
  type AdminModelListInput,
} from './adminModelList';
import {
  AWAITING_APPROVAL_REASON,
  AWAITING_PRICE_REASON,
  LEGACY_PRICED_IN_BUILD_REASON,
  NOT_INVOCABLE_REASON,
  PRICED_IN_BUILD_REASON,
  UNCORROBORATED_PRICE_REASON,
} from './promotion';
import { runModelDiscovery } from './runModelDiscovery';
import { BEDROCK_NOT_ENTITLED_REASON, BEDROCK_NOT_ON_DEMAND_REASON } from './sources/bedrock';
import type { DiscoveredModel, ModelDiscoveryAdapters } from './types';

const NOW = new Date('2026-08-01T12:00:00Z');
const EARLIER = new Date('2026-07-01T00:00:00Z');

const tier = (input: number, output: number) => ({ '0': { input, output } });

const adapter = (overrides: Partial<ModelInfo> & Pick<ModelInfo, 'id'>): ModelInfo =>
  ({
    type: 'text',
    name: String(overrides.id),
    backend: ModelBackend.OpenAI,
    contextWindow: 128_000,
    max_tokens: 16_000,
    pricing: tier(1e-6, 4e-6),
    supportsTools: true,
    ...overrides,
  }) as ModelInfo;

const catalogRow = (
  modelId: string,
  patch: Record<string, unknown>,
  overrides: Partial<IModelCatalogRow> = {}
): IModelCatalogRow => ({
  modelId,
  schemaVersion: CATALOG_SCHEMA_VERSION,
  source: 'discovery',
  ownedGroups: ['identity', 'limits', 'lifecycle', 'availability', 'dispatch'],
  patch,
  effectiveFrom: EARLIER,
  ...overrides,
});

/** A discovery row for a catalog-only model, blocked or promoted. */
const discovered = (
  modelId: string,
  overrides: Record<string, unknown> = {},
  rowOverrides: Partial<IModelCatalogRow> = {}
) =>
  catalogRow(
    modelId,
    {
      id: modelId,
      vendor: 'openai',
      backend: ModelBackend.OpenAI,
      type: 'text',
      name: modelId,
      contextWindow: 200_000,
      adapterFamily: 'openai-chat',
      dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
      lifecycle: { status: 'discovered' },
      autoDisabled: true,
      autoDisabledReason: AWAITING_PRICE_REASON,
      ...overrides,
    },
    rowOverrides
  );

const priceRow = (modelId: string, overrides: Partial<IModelPrice> = {}): IModelPrice => ({
  id: `price-${modelId}`,
  modelId,
  unit: 'per_token',
  pricing: tier(2e-6, 8e-6),
  effectiveFrom: EARLIER,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const entry = (id: string, overrides: Partial<LLMModelConfig> & { updatedAt?: Date } = {}) =>
  ({ id, enabled: true, allowedUserTags: [], allowedEntitlements: ['base'], ...overrides }) as LLMModelConfig;

const input = (overrides: Partial<AdminModelListInput> = {}): AdminModelListInput => ({
  adapterModels: [],
  catalogRows: [],
  priceRows: [],
  accessEntries: [],
  pendingSuggestions: [],
  discoveryMilestones: new Map(),
  isBackendKeyed: () => true,
  enforceCredits: false,
  baseEntitlementKey: 'base',
  discoveryRunMode: 'write',
  now: NOW,
  ...overrides,
});

async function rowFor(id: string, overrides: Partial<AdminModelListInput>) {
  const rows = await buildAdminModelRows(input(overrides));
  const row = rows.find(candidate => candidate.id === id);
  if (!row) throw new Error(`${id} is not in the list`);
  return row;
}

const codes = (row: { reasons: { code: string }[] }) => row.reasons.map(reason => reason.code);

describe('buildAdminModelRows', () => {
  it('lists an adapter literal with no catalog row, no entry and its build price', async () => {
    const row = await rowFor('gpt-x', { adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], rank: 3 })] });

    expect(row).toMatchObject({
      status: 'listed',
      reasons: [],
      origin: 'default',
      adminEdited: false,
      keyPresent: true,
      rank: 3,
      rankProvisional: false,
      price: { source: 'build', pricing: tier(1e-6, 4e-6) },
      access: { entry: null, everyone: true, adminsOnly: false, freeTierLocked: false },
      lifecycle: { status: 'active' },
      profileOnlyFoundation: false,
    });
  });

  it('hides a model whose backend has no key in this environment, with a key-settings fix', async () => {
    const row = await rowFor('gpt-x', {
      adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'] })],
      isBackendKeyed: backend => backend !== ModelBackend.OpenAI,
    });

    expect(row.status).toBe('hidden');
    expect(row.keyPresent).toBe(false);
    expect(row.reasons).toEqual([
      {
        code: 'no-credential-for-backend',
        message: 'No OpenAI key is configured in this environment',
        fixAction: 'open-key-settings',
      },
    ]);
  });

  describe('discovered models', () => {
    it('shows an unpriced new text model as Needs review with Add price', async () => {
      const row = await rowFor('gpt-new', { catalogRows: [discovered('gpt-new')] });

      expect(row.status).toBe('needs-review');
      expect(row.origin).toBe('discovered');
      expect(row.reasons).toEqual([
        {
          code: 'price-none',
          message: 'No price yet. New models list once they have a price.',
          fixAction: 'add-price',
        },
      ]);
    });

    it('tells the admin to run discovery once the blocked model has a per-token price', async () => {
      const row = await rowFor('gpt-new', { catalogRows: [discovered('gpt-new')], priceRows: [priceRow('gpt-new')] });

      expect(row.status).toBe('needs-review');
      expect(row.reasons).toEqual([
        {
          code: 'awaiting-discovery-run',
          message: 'Priced. It lists on the next discovery run.',
          fixAction: 'run-discovery',
        },
      ]);
      expect(row.price).toMatchObject({ source: 'row', unit: 'per_token', rowId: 'price-gpt-new' });
    });

    it.each([
      [UNCORROBORATED_PRICE_REASON, 'price-aggregator-quote', 'needs-review'],
      [AWAITING_APPROVAL_REASON, 'manual-approval-required', 'needs-review'],
      [NOT_INVOCABLE_REASON, 'not-callable', 'hidden'],
    ])('maps %s to %s', async (stored, code, status) => {
      const row = await rowFor('gpt-new', { catalogRows: [discovered('gpt-new', { autoDisabledReason: stored })] });

      expect(codes(row)).toEqual([code]);
      expect(row.status).toBe(status);
    });

    it('hides a non-text model with no build literal, under the new and the legacy wording', async () => {
      for (const stored of [PRICED_IN_BUILD_REASON, LEGACY_PRICED_IN_BUILD_REASON]) {
        const row = await rowFor('flux-9', {
          catalogRows: [
            discovered('flux-9', {
              backend: ModelBackend.BFL,
              vendor: 'bfl',
              type: 'image',
              autoDisabledReason: stored,
            }),
          ],
        });

        expect(row.status).toBe('hidden');
        expect(row.reasons).toEqual([
          { code: 'price-no-build-literal', message: "No price in this build's model tables" },
        ]);
        expect(row.price).toBeNull();
      }
    });

    it('offers Run now for an OpenAI id discovery can probe, only in write mode, and nothing for another backend', () => {
      const fix = (backend: string, mode: 'write' | 'report' | 'off') =>
        adminReasonsFromDisableText(NOT_INVOCABLE_REASON, backend, mode)[0].fixAction;

      expect(fix(ModelBackend.OpenAI, 'write')).toBe('run-discovery');
      expect(fix(ModelBackend.OpenAI, 'report')).toBeUndefined();
      expect(fix(ModelBackend.OpenAI, 'off')).toBeUndefined();
      expect(fix(ModelBackend.Anthropic, 'write')).toBeUndefined();
    });

    it('reads a no-credential blocker out of the generic verdict', () => {
      expect(
        adminReasonsFromDisableText(
          'discovered, no-dispatch-profile, no-credential-for-backend',
          ModelBackend.XAI,
          'write'
        )
      ).toEqual([
        {
          code: 'no-credential-for-backend',
          message: 'No xAI key is configured in this environment',
          fixAction: 'open-key-settings',
        },
      ]);
    });

    it('drops a stored no-credential verdict once the key is configured', async () => {
      const keyless = discovered('gpt-new', { autoDisabledReason: 'discovered, no-credential-for-backend' });

      const keyed = await rowFor('gpt-new', { catalogRows: [keyless] });
      expect(keyed.keyPresent).toBe(true);
      expect(keyed.status).toBe('needs-review');
      expect(keyed.reasons).toEqual([
        {
          code: 'awaiting-discovery-run',
          message: 'OpenAI key configured. It lists on the next discovery run.',
          fixAction: 'run-discovery',
        },
      ]);

      const stillKeyless = await rowFor('gpt-new', { catalogRows: [keyless], isBackendKeyed: () => false });
      expect(stillKeyless.reasons).toEqual([
        {
          code: 'no-credential-for-backend',
          message: 'No OpenAI key is configured in this environment',
          fixAction: 'open-key-settings',
        },
      ]);
    });

    it('words a cleared blocker for the discovery mode, with Run now only in write mode', async () => {
      const priced = { catalogRows: [discovered('gpt-new')], priceRows: [priceRow('gpt-new')] };

      expect((await rowFor('gpt-new', { ...priced, discoveryRunMode: 'report' })).reasons).toEqual([
        {
          code: 'awaiting-discovery-run',
          message: 'Priced. Discovery only reports right now, so it lists after a run in write mode.',
        },
      ]);
      expect((await rowFor('gpt-new', { ...priced, discoveryRunMode: 'off' })).reasons).toEqual([
        {
          code: 'awaiting-discovery-run',
          message: 'Priced. Model discovery is off, so it lists after a run in write mode.',
        },
      ]);
    });

    it('reads an operator disable on a discovered model as an admin disable, beside its discovery verdict', async () => {
      const operatorRow = (patch: Record<string, unknown>) =>
        catalogRow('gpt-new', patch, {
          source: 'operator',
          ownedGroups: ['availability'],
          effectiveFrom: NOW,
          note: 'pause',
        });

      const paused = await rowFor('gpt-new', {
        catalogRows: [discovered('gpt-new'), operatorRow({ disabled: true, disabledReason: 'billing dispute' })],
      });
      expect(paused.reasons).toEqual([
        { code: 'operator-disabled', message: 'Disabled: billing dispute' },
        {
          code: 'price-none',
          message: 'No price yet. New models list once they have a price.',
          fixAction: 'add-price',
        },
      ]);
      expect(paused).toMatchObject({ status: 'hidden', adminEdited: true });

      const unexplained = await rowFor('gpt-new', {
        catalogRows: [discovered('gpt-new', { autoDisabledReason: undefined }), operatorRow({ disabled: true })],
      });
      expect(unexplained.reasons).toEqual([{ code: 'operator-disabled', message: 'Disabled by an admin' }]);
    });

    it('reads the verdict under an operator disable from the newest row that states one', async () => {
      const row = await rowFor('gpt-new', {
        catalogRows: [
          discovered('gpt-new', { autoDisabledReason: AWAITING_APPROVAL_REASON }),
          catalogRow(
            'gpt-new',
            { autoDisabled: false },
            { source: 'seed', ownedGroups: ['availability'], effectiveFrom: NOW }
          ),
          catalogRow(
            'gpt-new',
            { disabled: true },
            { source: 'operator', ownedGroups: ['availability'], effectiveFrom: NOW, note: 'pause' }
          ),
        ],
      });

      expect(codes(row)).toEqual(['operator-disabled', 'manual-approval-required']);
    });
  });

  describe('catalog-only models the merge drops', () => {
    const active = (modelId: string, overrides: Record<string, unknown> = {}) =>
      discovered(modelId, {
        lifecycle: { status: 'active' },
        autoDisabled: false,
        autoDisabledReason: undefined,
        ...overrides,
      });

    it('offers Run now for a missing request profile on an OpenAI id, in write mode only', async () => {
      const row = await rowFor('gpt-new', { catalogRows: [active('gpt-new', { dispatchProfile: undefined })] });
      expect(row.reasons).toEqual([
        {
          code: 'not-callable',
          message: 'We cannot call this model yet: no request profile for it',
          fixAction: 'run-discovery',
          detail: 'no dispatchProfile',
        },
      ]);

      const reportMode = await rowFor('gpt-new', {
        catalogRows: [active('gpt-new', { dispatchProfile: undefined })],
        discoveryRunMode: 'report',
      });
      expect(reportMode.reasons[0].fixAction).toBeUndefined();
    });

    it('gives a lifecycle drop and a dedicated-API drop their own words and no Run now', async () => {
      const unlisted = await rowFor('gpt-new', {
        catalogRows: [active('gpt-new', { lifecycle: { status: 'unlisted' } })],
      });
      expect(unlisted.reasons).toEqual([
        {
          code: 'not-callable',
          message: 'Not offered while its catalog lifecycle status is "unlisted"',
          detail: 'lifecycle status "unlisted" is not invocable',
        },
      ]);
      expect(unlisted.status).toBe('hidden');

      const dedicated = await rowFor('o3-deep-research-x', {
        catalogRows: [active('o3-deep-research-x')],
      });
      expect(dedicated.reasons).toEqual([
        {
          code: 'not-callable',
          message: 'It needs a dedicated API or a mandatory tool, so it cannot be offered as a text model',
          detail: 'needs a dedicated API or a mandatory tool; not callable as a plain text model',
        },
      ]);
    });
  });

  describe('source and build disables', () => {
    const bedrockRow = (modelId: string, reason: string) =>
      catalogRow(modelId, {
        id: modelId,
        vendor: 'anthropic',
        backend: ModelBackend.Bedrock,
        type: 'text',
        name: modelId,
        contextWindow: 200_000,
        adapterFamily: 'bedrock-converse',
        dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'native' },
        lifecycle: { status: 'active' },
        disabled: true,
        disabledReason: reason,
      });

    it('flags a profile-only Bedrock foundation id', async () => {
      const row = await rowFor('anthropic.claude-x-v1:0', {
        catalogRows: [bedrockRow('anthropic.claude-x-v1:0', BEDROCK_NOT_ON_DEMAND_REASON)],
      });

      expect(row.status).toBe('hidden');
      expect(codes(row)).toEqual(['source-not-on-demand']);
      expect(row.profileOnlyFoundation).toBe(true);
    });

    it('maps a Bedrock entitlement disable and shows any other source text verbatim', async () => {
      const entitled = await rowFor('anthropic.claude-y-v1:0', {
        catalogRows: [bedrockRow('anthropic.claude-y-v1:0', BEDROCK_NOT_ENTITLED_REASON)],
      });
      expect(codes(entitled)).toEqual(['source-not-entitled']);

      const other = await rowFor('anthropic.claude-z-v1:0', {
        catalogRows: [bedrockRow('anthropic.claude-z-v1:0', 'provider says LEGACY')],
      });
      expect(other.reasons).toEqual([
        {
          code: 'source-disabled',
          message: 'The provider lists it as unavailable: provider says LEGACY',
          detail: 'provider says LEGACY',
        },
      ]);
    });

    it('names an operator disable and a build disable apart', async () => {
      const operator = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'] })],
        catalogRows: [
          catalogRow(
            'gpt-x',
            { disabled: true, disabledReason: 'billing dispute' },
            { source: 'operator', ownedGroups: ['availability'], note: 'pause' }
          ),
        ],
      });
      expect(operator.reasons).toEqual([{ code: 'operator-disabled', message: 'Disabled: billing dispute' }]);
      expect(operator).toMatchObject({ status: 'hidden', adminEdited: true, origin: 'default' });

      const build = await rowFor('gpt-y', {
        adapterModels: [adapter({ id: 'gpt-y' as ModelInfo['id'], disabled: true, disabledReason: 'access lapsed' })],
      });
      expect(build.reasons).toEqual([{ code: 'build-disabled', message: 'Disabled in this build: access lapsed' }]);
    });

    it('says when a catalog-only model lacks a context window', async () => {
      const row = await rowFor('gpt-new', {
        catalogRows: [
          discovered('gpt-new', {
            contextWindow: undefined,
            lifecycle: { status: 'active' },
            autoDisabled: false,
            autoDisabledReason: undefined,
          }),
        ],
      });

      expect(codes(row)).toEqual(['missing-context-window']);
      expect(row.status).toBe('hidden');
    });

    it('hides a private model', async () => {
      const row = await rowFor('flux-fill', {
        adapterModels: [
          adapter({ id: 'flux-fill' as ModelInfo['id'], backend: ModelBackend.BFL, type: 'image', private: true }),
        ],
      });

      expect(codes(row)).toEqual(['private']);
      expect(row.status).toBe('hidden');
    });
  });

  describe('prices', () => {
    it('needs a price for a served text model only while credits are enforced', async () => {
      const unpriced = adapter({ id: 'gpt-x' as ModelInfo['id'], pricing: {} });

      const enforced = await rowFor('gpt-x', { adapterModels: [unpriced], enforceCredits: true });
      expect(enforced.status).toBe('needs-review');
      expect(enforced.reasons).toEqual([
        {
          code: 'price-missing',
          message: 'No price yet. Text models need a price while credits are enforced.',
          fixAction: 'add-price',
        },
      ]);
      expect(enforced.price).toBeNull();

      expect((await rowFor('gpt-x', { adapterModels: [unpriced] })).status).toBe('listed');
    });

    it('shows a non-text model only its build literal, never a price row', async () => {
      const imageRows = [
        priceRow('gpt-image-x', { unit: 'per_image', pricing: tier(0.04, 0) }),
        priceRow('gpt-image-x', { id: 'token-row', pricing: tier(5e-6, 0) }),
      ];

      const literal = await rowFor('gpt-image-x', {
        adapterModels: [adapter({ id: 'gpt-image-x' as ModelInfo['id'], type: 'image' })],
        priceRows: imageRows,
      });
      expect(literal.price).toEqual({ source: 'build', pricing: tier(1e-6, 4e-6) });

      const catalogOnly = await rowFor('flux-9', {
        catalogRows: [discovered('flux-9', { backend: ModelBackend.BFL, type: 'image' })],
        priceRows: [priceRow('flux-9', { unit: 'per_image', pricing: tier(0.04, 0) })],
      });
      expect(catalogOnly.price).toBeNull();
    });

    it('shows a realtime voice price the way voice settlement reads it', async () => {
      const voiceTier = { '0': { input: 4e-6, output: 16e-6, audio_input: 32e-6, audio_output: 64e-6 } };
      const voice = (modelId: string, pricing: IModelPrice['pricing']) =>
        rowFor(modelId, {
          catalogRows: [discovered(modelId, { type: 'realtime-voice' })],
          priceRows: [priceRow(modelId, { pricing })],
        });

      expect((await voice('gpt-realtime-x', voiceTier)).price).toMatchObject({
        source: 'row',
        unit: 'per_token',
        rowId: 'price-gpt-realtime-x',
      });
      // A row without audio rates is skipped for the literal, or for nothing this build prices.
      expect((await voice('gpt-realtime-1.5', tier(2e-6, 8e-6))).price).toEqual({
        source: 'build',
        pricing: { '0': REALTIME_VOICE_PRICING['gpt-realtime-1.5'] },
      });
      expect((await voice('gpt-realtime-x', tier(2e-6, 8e-6))).price).toBeNull();
    });
  });

  describe('access', () => {
    const model = adapter({ id: 'gpt-x' as ModelInfo['id'] });

    it('hides a model turned off by an admin, and tells a pre-promotion bulk save apart', async () => {
      const off = await rowFor('gpt-x', {
        adapterModels: [model],
        accessEntries: [entry('gpt-x', { enabled: false })],
      });
      expect(off.reasons).toEqual([{ code: 'admin-off', message: 'Turned off by an admin', fixAction: 'turn-on' }]);
      expect(off.status).toBe('hidden');

      const stale = await rowFor('gpt-x', {
        adapterModels: [model],
        accessEntries: [entry('gpt-x', { enabled: false, updatedAt: EARLIER })],
        discoveryMilestones: new Map([
          ['gpt-x', { firstSeenAt: EARLIER, activatedAt: new Date('2026-07-15T00:00:00Z') }],
        ]),
      });
      expect(codes(stale)).toEqual(['admin-off-before-promotion']);
      expect(stale.access.entry?.updatedAt).toBe(EARLIER.toISOString());
      expect(stale.firstSeenAt).toBe(EARLIER.toISOString());
    });

    it.each([{ allowedEntitlements: ['base'] }, { allowedEntitlements: [] }])(
      'keeps a legacy entry without enabled off for $allowedEntitlements',
      async ({ allowedEntitlements }) => {
        const legacy = entry('gpt-x', { allowedEntitlements });
        Reflect.deleteProperty(legacy, 'enabled');
        const row = await rowFor('gpt-x', { adapterModels: [model], accessEntries: [legacy] });
        expect(row.status).toBe('hidden');
        expect(codes(row)).toEqual(['admin-off']);
        expect(row.access).toMatchObject({ entry: { enabled: false }, adminsOnly: false });
      }
    );

    it('marks a model Limited when not everyone can pick it', async () => {
      const tagged = await rowFor('gpt-x', {
        adapterModels: [model],
        accessEntries: [entry('gpt-x', { allowedUserTags: ['beta'], allowedEntitlements: [] })],
      });
      expect(tagged.status).toBe('limited');
      expect(tagged.access).toMatchObject({ everyone: false, adminsOnly: false });

      const adminsOnly = await rowFor('gpt-x', {
        adapterModels: [model],
        accessEntries: [entry('gpt-x', { allowedEntitlements: [] })],
      });
      expect(adminsOnly.status).toBe('limited');
      expect(adminsOnly.access.adminsOnly).toBe(true);

      const everyone = await rowFor('gpt-x', {
        adapterModels: [model],
        accessEntries: [entry('gpt-x', { allowedEntitlements: [' Base '] })],
      });
      expect(everyone.status).toBe('listed');

      const freeTier = await rowFor('gpt-x', { adapterModels: [model], freeTierAllowedModels: new Set(['other']) });
      expect(freeTier.status).toBe('limited');
      expect(freeTier.access.freeTierLocked).toBe(true);
    });

    it('ranks by the saved entry over the catalog, else provisionally', async () => {
      const rows = await buildAdminModelRows(
        input({
          adapterModels: [
            adapter({ id: 'gpt-a' as ModelInfo['id'], name: 'GPT A', rank: 2 }),
            adapter({ id: 'gpt-b' as ModelInfo['id'], name: 'GPT B', rank: 6 }),
            adapter({ id: 'gpt-c' as ModelInfo['id'], name: 'GPT C' }),
          ],
          accessEntries: [entry('gpt-a', { rank: 9 })],
        })
      );
      const byId = new Map(rows.map(row => [row.id, row]));

      expect(byId.get('gpt-a')).toMatchObject({ rank: 9, rankProvisional: false });
      expect(byId.get('gpt-b')).toMatchObject({ rank: 6, rankProvisional: false });
      expect(byId.get('gpt-c')).toMatchObject({ rank: 9, rankProvisional: true });
    });

    it('ranks an unranked model within its picker section, over the models the picker offers', async () => {
      const rows = await buildAdminModelRows(
        input({
          adapterModels: [
            adapter({ id: 'gpt-a' as ModelInfo['id'], name: 'GPT A', rank: 2 }),
            adapter({ id: 'gpt-b' as ModelInfo['id'], name: 'GPT B', rank: 4 }),
            adapter({ id: 'gpt-c' as ModelInfo['id'], name: 'GPT C' }),
            adapter({ id: 'gpt-off' as ModelInfo['id'], name: 'GPT Off', rank: 50, disabled: true }),
            adapter({ id: 'gpt-hidden' as ModelInfo['id'], name: 'GPT Hidden', disabled: true }),
            adapter({ id: 'gpt-gone' as ModelInfo['id'], name: 'GPT Gone', deprecationDate: '2026-07-01' }),
            adapter({ id: 'claude-a' as ModelInfo['id'], name: 'Claude A', backend: ModelBackend.Anthropic, rank: 1 }),
            adapter({ id: 'claude-b' as ModelInfo['id'], name: 'Claude B', backend: ModelBackend.Anthropic }),
          ],
        })
      );
      const byId = new Map(rows.map(row => [row.id, row]));

      // OpenAI section offers gpt-a (2) and gpt-b (4): the upper median is 4, untouched by the hidden rank 50.
      expect(byId.get('gpt-c')).toMatchObject({ rank: 4, rankProvisional: true });
      expect(byId.get('claude-b')).toMatchObject({ rank: 1, rankProvisional: true });
      expect(byId.get('gpt-off')).toMatchObject({ status: 'hidden', rank: 50, rankProvisional: false });
      expect(byId.get('gpt-hidden')).toMatchObject({ status: 'hidden', rank: null, rankProvisional: true });
      expect(byId.get('gpt-gone')).toMatchObject({ status: 'retired', rank: null, rankProvisional: true });
    });
  });

  describe('lifecycle', () => {
    it('puts a pending lifecycle suggestion up for review', async () => {
      const row = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'] })],
        pendingSuggestions: [
          { modelId: 'gpt-x', suggestion: { status: 'deprecated', source: 'openai', suggestedAt: EARLIER } },
        ],
      });

      expect(row.status).toBe('needs-review');
      expect(row.reasons).toEqual([
        { code: 'lifecycle-suggestion', message: 'Provider marked it deprecated', fixAction: 'review-lifecycle' },
      ]);
      expect(row.lifecycleSuggestion).toMatchObject({ status: 'deprecated', source: 'openai' });
    });

    it('shows Retiring within 90 days of a date and Retired once it passes', async () => {
      const soon = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], deprecationDate: '2026-09-15' })],
      });
      expect(soon.status).toBe('retiring');

      const far = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], deprecationDate: '2027-09-15' })],
      });
      expect(far.status).toBe('listed');

      const past = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], deprecationDate: '2026-07-15' })],
      });
      expect(past.status).toBe('retired');
    });

    it('reads a passed retirement date as Retiring while the model is still served', async () => {
      const lifecycleRow = (lifecycle: Record<string, unknown>) =>
        catalogRow('gpt-x', { lifecycle }, { ownedGroups: ['lifecycle'] });
      const served = adapter({ id: 'gpt-x' as ModelInfo['id'] });

      const noDeprecation = await rowFor('gpt-x', {
        adapterModels: [served],
        catalogRows: [lifecycleRow({ status: 'active', retirementDate: '2026-07-15' })],
      });
      expect(noDeprecation.status).toBe('retiring');

      const laterDeprecation = await rowFor('gpt-x', {
        adapterModels: [served],
        catalogRows: [lifecycleRow({ status: 'active', retirementDate: '2026-07-15', deprecationDate: '2027-01-01' })],
      });
      expect(laterDeprecation.status).toBe('retiring');

      const markedRetired = await rowFor('gpt-x', {
        adapterModels: [served],
        catalogRows: [lifecycleRow({ status: 'retired' })],
      });
      expect(markedRetired.status).toBe('retiring');

      const deprecatedToday = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], deprecationDate: '2026-08-01' })],
      });
      expect(deprecatedToday.status).toBe('retired');
    });

    it('reads a served model the provider retired as Retired, not as a provider disable', async () => {
      const row = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'] })],
        catalogRows: [
          catalogRow('gpt-x', { lifecycle: { status: 'retired' } }, { ownedGroups: ['lifecycle', 'availability'] }),
        ],
      });

      expect(row).toMatchObject({ status: 'retired', reasons: [] });
      expect(filterAdminModels([row], { view: 'retiring' }).map(candidate => candidate.id)).toEqual(['gpt-x']);
    });

    it('carries the sooner lifecycle date and the days left to it', async () => {
      const served = adapter({ id: 'gpt-x' as ModelInfo['id'] });

      const both = await rowFor('gpt-x', {
        adapterModels: [served],
        catalogRows: [
          catalogRow(
            'gpt-x',
            { lifecycle: { status: 'active', deprecationDate: '2026-09-15', retirementDate: '2026-08-21' } },
            { ownedGroups: ['lifecycle'] }
          ),
        ],
      });
      expect(both).toMatchObject({
        lifecycle: { deprecationDate: '2026-09-15', retirementDate: '2026-08-21' },
        sunsetDate: '2026-08-21',
        sunsetDays: 20,
      });

      const passed = await rowFor('gpt-x', {
        adapterModels: [adapter({ id: 'gpt-x' as ModelInfo['id'], deprecationDate: '2026-07-15' })],
      });
      expect(passed).toMatchObject({ status: 'retired', sunsetDate: '2026-07-15', sunsetDays: -17 });

      expect(await rowFor('gpt-x', { adapterModels: [served] })).toMatchObject({ sunsetDate: null, sunsetDays: null });
    });

    it('shows a sunset catalog-only model as Retired with no reasons', async () => {
      const row = await rowFor('gpt-old', {
        catalogRows: [discovered('gpt-old', { lifecycle: { status: 'retired' }, autoDisabled: false })],
      });

      expect(row.status).toBe('retired');
      expect(row.reasons).toEqual([]);
    });
  });
});

describe('the list page and the filter resolver', () => {
  const models = [
    adapter({ id: 'gpt-a' as ModelInfo['id'], name: 'GPT A', rank: 1 }),
    adapter({ id: 'gpt-b' as ModelInfo['id'], name: 'GPT B', rank: 2, deprecationDate: '2026-09-01' }),
    adapter({ id: 'gemini-a' as ModelInfo['id'], name: 'Gemini A', backend: ModelBackend.Gemini, rank: 1 }),
    adapter({ id: 'gpt-image-a' as ModelInfo['id'], name: 'GPT Image A', type: 'image', rank: 1 }),
  ];
  const catalogRows = [
    discovered('gpt-new'),
    catalogRow('anthropic.claude-x-v1:0', {
      id: 'anthropic.claude-x-v1:0',
      vendor: 'anthropic',
      backend: ModelBackend.Bedrock,
      type: 'text',
      name: 'Claude X',
      contextWindow: 200_000,
      lifecycle: { status: 'active' },
      disabled: true,
      disabledReason: BEDROCK_NOT_ON_DEMAND_REASON,
    }),
  ];
  const rows = () => buildAdminModelRows(input({ adapterModels: models, catalogRows }));

  it('leaves profile-only foundation ids out of the default view and counts them for the chip', async () => {
    const page = adminModelListPage(await rows(), { filter: {} });

    expect(page.models.map(row => row.id)).not.toContain('anthropic.claude-x-v1:0');
    expect(page.foundationIds).toBe(1);
    expect(page.total).toBe(5);
    expect(page.counts).toEqual({ listed: 3, limited: 0, 'needs-review': 1, hidden: 0, retiring: 1, retired: 0 });

    const restored = adminModelListPage(await rows(), { filter: { showFoundationIds: true } });
    expect(restored.total).toBe(6);
    expect(restored.counts.hidden).toBe(1);
  });

  it('sorts actionable statuses first, then by rank, and pages', async () => {
    const all = await rows();
    const page = adminModelListPage(await rows(), { filter: {}, pageSize: 2 });

    expect(page.models.map(row => row.id)).toEqual(['gpt-new', 'gpt-b']);
    expect(page).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(adminModelListPage(await rows(), { filter: {}, pageSize: 2, page: 3 }).models).toHaveLength(1);
    const byName = (dir: 'asc' | 'desc') =>
      adminModelListPage(all, { filter: {}, sort: 'name', dir }).models.map(row => row.id);
    expect(byName('desc')).toEqual([...byName('asc')].reverse());

    const byRank = (dir: 'asc' | 'desc') =>
      adminModelListPage(all, { filter: {}, sort: 'rank', dir, pageSize: 500 }).models.map(row => [row.id, row.rank]);
    for (const dir of ['asc', 'desc'] as const) {
      const ranks = byRank(dir).map(([, rank]) => rank);
      const firstBlank = ranks.indexOf(null);
      expect(firstBlank).toBeGreaterThan(0);
      expect(ranks.slice(firstBlank).every(rank => rank === null)).toBe(true);
    }
    const present = (dir: 'asc' | 'desc') => byRank(dir).filter(([, rank]) => rank !== null);
    expect(present('desc').map(([, rank]) => rank)).toEqual(
      present('asc')
        .map(([, rank]) => rank)
        .reverse()
    );
  });

  it('applies the view, search, provider, type and source facets', async () => {
    const all = await rows();
    const ids = (filter: Parameters<typeof filterAdminModels>[1]) => filterAdminModels(all, filter).map(row => row.id);

    expect(ids({ view: 'listed' })).toEqual(['gemini-a', 'gpt-a', 'gpt-image-a']);
    expect(ids({ view: 'retiring' })).toEqual(['gpt-b']);
    expect(ids({ view: 'needs-review' })).toEqual(['gpt-new']);
    expect(ids({ view: 'hidden' })).toEqual([]);
    expect(ids({ view: 'hidden', showFoundationIds: true })).toEqual(['anthropic.claude-x-v1:0']);
    expect(ids({ search: 'image' })).toEqual(['gpt-image-a']);
    expect(ids({ providers: [ModelBackend.Gemini] })).toEqual(['gemini-a']);
    expect(ids({ types: ['image'] })).toEqual(['gpt-image-a']);
    expect(ids({ sources: ['discovered'] })).toEqual(['gpt-new']);
    expect(() => filterAdminModels(all, { view: 'nope' } as never)).toThrow();
  });

  it('puts a retired or retiring model with a pending lifecycle suggestion under Needs review too', async () => {
    const pendingSuggestions = [
      { modelId: 'gpt-gone', suggestion: { status: 'retired' as const, source: 'openai', suggestedAt: EARLIER } },
    ];
    const withSuggestion = await buildAdminModelRows(
      input({
        adapterModels: [
          ...models,
          adapter({ id: 'gpt-gone' as ModelInfo['id'], name: 'GPT Gone', deprecationDate: '2026-07-01' }),
        ],
        catalogRows,
        pendingSuggestions,
      })
    );

    expect(withSuggestion.find(row => row.id === 'gpt-gone')?.status).toBe('retired');
    expect(filterAdminModels(withSuggestion, { view: 'needs-review' }).map(row => row.id)).toEqual([
      'gpt-gone',
      'gpt-new',
    ]);
    expect(filterAdminModels(withSuggestion, { view: 'retiring' }).map(row => row.id)).toEqual(['gpt-b', 'gpt-gone']);

    const page = adminModelListPage(withSuggestion, { filter: { view: 'needs-review' } });
    expect(page.total).toBe(2);
    expect(page.counts['needs-review']).toBe(1);
    expect(page.viewCounts).toEqual({ all: 6, 'needs-review': 2, listed: 3, hidden: 0, retiring: 2 });
  });

  describe('the Retiring view and the sunset sort', () => {
    const lifecycleRow = (modelId: string, lifecycle: Record<string, unknown>) =>
      catalogRow(modelId, { lifecycle }, { ownedGroups: ['lifecycle'] });
    const model = (id: string, overrides: Partial<ModelInfo> = {}) =>
      adapter({ id: id as ModelInfo['id'], name: id, ...overrides });
    // NOW is 2026-08-01: 2026-10-30 is 90 days out, 2026-10-31 is 91.
    const retiringRows = () =>
      buildAdminModelRows(
        input({
          adapterModels: [
            model('gpt-x', { rank: 1 }),
            model('gpt-y', { rank: 2 }),
            model('gpt-a', { rank: 5 }),
            model('gpt-off', { rank: 3 }),
            model('gpt-overdue', { rank: 4 }),
            model('gpt-edge', { deprecationDate: '2026-10-30' }),
            model('gpt-far', { deprecationDate: '2026-10-31' }),
            model('gpt-far-off', { deprecationDate: '2026-10-31' }),
            model('gpt-marked', { rank: 7 }),
            model('flux-fill', {
              backend: ModelBackend.BFL,
              type: 'image',
              private: true,
              deprecationDate: '2026-09-01',
            }),
          ],
          catalogRows: [
            // Discovery deprecated it with a date and, with auto-remap off, suggested a successor.
            lifecycleRow('gpt-x', { status: 'deprecated', deprecationDate: '2026-08-21' }),
            lifecycleRow('gpt-off', { status: 'active', retirementDate: '2026-09-01' }),
            lifecycleRow('gpt-overdue', { status: 'active', retirementDate: '2026-07-15' }),
            lifecycleRow('gpt-marked', { status: 'deprecated' }),
          ],
          accessEntries: [
            entry('gpt-off', { enabled: false }),
            entry('gpt-overdue', { enabled: false }),
            entry('gpt-far-off', { enabled: false }),
          ],
          pendingSuggestions: [
            { modelId: 'gpt-x', suggestion: { replacedBy: 'gpt-y', source: 'openai', suggestedAt: EARLIER } },
          ],
        })
      );
    const RETIRING = ['flux-fill', 'gpt-edge', 'gpt-marked', 'gpt-off', 'gpt-overdue', 'gpt-x'];

    it('takes every model its lifecycle dates or status put there, whatever its status', async () => {
      const all = await retiringRows();
      const status = new Map(all.map(row => [row.id, row.status]));

      expect(Object.fromEntries(RETIRING.map(id => [id, status.get(id)]))).toEqual({
        'flux-fill': 'hidden',
        'gpt-edge': 'retiring',
        'gpt-marked': 'retiring',
        'gpt-off': 'hidden',
        'gpt-overdue': 'hidden',
        'gpt-x': 'needs-review',
      });
      expect(filterAdminModels(all, { view: 'retiring' }).map(row => row.id)).toEqual(RETIRING);
      expect(filterAdminModels(all, { view: 'needs-review' }).map(row => row.id)).toEqual(['gpt-x']);

      const page = adminModelListPage(all, { filter: { view: 'retiring' }, pageSize: 500 });
      expect(page.total).toBe(RETIRING.length);
      expect(page.viewCounts).toEqual({ all: 10, 'needs-review': 1, listed: 3, hidden: 4, retiring: 6 });
      expect(page.counts).toEqual({ listed: 3, limited: 0, 'needs-review': 1, hidden: 4, retiring: 2, retired: 0 });
    });

    it('leaves out a model dated 91 days out, whatever its status', async () => {
      const all = await retiringRows();
      const far = all.filter(row => row.id === 'gpt-far' || row.id === 'gpt-far-off');

      expect(far.map(row => [row.id, row.status, row.sunsetDays])).toEqual([
        ['gpt-far', 'listed', 91],
        ['gpt-far-off', 'hidden', 91],
      ]);
      expect(filterAdminModels(far, { view: 'retiring' })).toEqual([]);
    });

    it('sorts by the sooner lifecycle date, most overdue first and undated models last', async () => {
      const all = await retiringRows();
      const sorted = (filter: Parameters<typeof adminModelListPage>[1]['filter'], dir?: 'asc' | 'desc') =>
        adminModelListPage(all, { filter, sort: 'sunset', dir, pageSize: 500 }).models.map(row => row.id);

      // Equal dates fall back to rank: gpt-off is ranked, flux-fill is not.
      expect(sorted({})).toEqual([
        'gpt-overdue',
        'gpt-x',
        'gpt-off',
        'flux-fill',
        'gpt-edge',
        'gpt-far',
        'gpt-far-off',
        'gpt-y',
        'gpt-a',
        'gpt-marked',
      ]);
      expect(sorted({}, 'desc')).toEqual([
        'gpt-far',
        'gpt-far-off',
        'gpt-edge',
        'gpt-off',
        'flux-fill',
        'gpt-x',
        'gpt-overdue',
        'gpt-marked',
        'gpt-a',
        'gpt-y',
      ]);
      expect(sorted({ view: 'retiring' })).toEqual([
        'gpt-overdue',
        'gpt-x',
        'gpt-off',
        'flux-fill',
        'gpt-edge',
        'gpt-marked',
      ]);
    });
  });

  it('offers every provider and type present as facets', async () => {
    const page = adminModelListPage(await rows(), { filter: { view: 'listed' } });

    expect(page.facets).toEqual({
      providers: [ModelBackend.Bedrock, ModelBackend.Gemini, ModelBackend.OpenAI],
      types: ['image', 'text'],
    });
  });
});

describe('against the build tables and a discovery run', () => {
  const START = new Date('2026-07-26T10:00:00Z');

  function discoveryBench(records: DiscoveredModel[], source = 'openai', backend = ModelBackend.OpenAI) {
    const catalog = new FakeCatalogRepository();
    const prices = new FakePriceRepository();
    const adapters: ModelDiscoveryAdapters = {
      db: {
        catalog,
        discoveryState: new FakeDiscoveryStateRepository(),
        discoveryRuns: new FakeRunRepository(),
        cache: new FakeCacheRepository(),
        adminSettings: new FakeAdminSettingsRepository({
          modelDiscoveryMode: 'write',
          modelDiscoveryAutoEnable: 'priced',
        }),
        prices,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sources: [stubSource({ name: source, kind: 'provider', records, authoritativeFor: [backend] })],
      resolveCredentials: async () => testCredentials(),
      resolveDispatch: () => ({
        adapterFamily: 'openai-chat',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
      }),
      env: {},
    };
    const run = () =>
      runModelDiscovery(adapters, { trigger: 'manual', host: 'hosted', minSourceIntervalMs: 0, now: () => START });
    const list = async () =>
      buildAdminModelRows(
        input({
          adapterModels: await staticAdapterModels(),
          catalogRows: (await catalog.rowsInForceWithRejects(START)).rows,
          priceRows: await prices.rowsInForce(START),
          now: START,
        })
      );
    return { run, list, catalog };
  }

  it('lists a priced model a discovery run found, on the next fetch', async () => {
    const bench = discoveryBench([
      {
        modelId: 'gpt-6-admin-list',
        patch: {
          id: 'gpt-6-admin-list',
          vendor: 'openai',
          backend: ModelBackend.OpenAI,
          type: 'text',
          name: 'GPT-6 admin list',
          contextWindow: 400_000,
        },
        pricing: { inputPerMTok: 2, outputPerMTok: 8 },
      },
    ]);
    expect((await bench.list()).some(row => row.id === 'gpt-6-admin-list')).toBe(false);

    expect((await bench.run()).outcome).toBe('ok');

    const row = (await bench.list()).find(candidate => candidate.id === 'gpt-6-admin-list');
    expect(row).toMatchObject({ status: 'listed', origin: 'discovered', reasons: [] });
    expect(row?.price).toMatchObject({ source: 'row', unit: 'per_token' });
  });

  it('lists an OpenAI image id on its build literal under priced, and keeps a new BFL id Hidden', async () => {
    const openai = discoveryBench([
      {
        modelId: 'gpt-image-2',
        patch: {
          id: 'gpt-image-2',
          vendor: 'openai',
          backend: ModelBackend.OpenAI,
          type: 'image',
          name: 'GPT Image 2',
        },
      },
    ]);
    expect((await openai.run()).outcome).toBe('ok');
    expect(openai.catalog.rows.find(row => row.modelId === 'gpt-image-2')?.patch).toMatchObject({
      lifecycle: { status: 'active' },
      autoDisabled: false,
    });
    const image = (await openai.list()).find(candidate => candidate.id === 'gpt-image-2');
    expect(image).toMatchObject({ status: 'listed', reasons: [], price: { source: 'build' } });

    const bfl = discoveryBench(
      [
        {
          modelId: 'flux-admin-list-9',
          patch: {
            id: 'flux-admin-list-9',
            vendor: 'bfl',
            backend: ModelBackend.BFL,
            type: 'image',
            name: 'FLUX admin list 9',
            contextWindow: 4_096,
          },
        },
      ],
      'bfl',
      ModelBackend.BFL
    );
    expect((await bfl.run()).outcome).toBe('ok');
    const flux = (await bfl.list()).find(candidate => candidate.id === 'flux-admin-list-9');
    expect(flux?.status).toBe('hidden');
    expect(codes(flux ?? { reasons: [] })).toContain('price-no-build-literal');
  });

  it('shows every adapter literal and catalog id under the default view or the foundation-ids chip', async () => {
    const adapterModels = await staticAdapterModels();
    const catalogRows = [
      discovered('gpt-new'),
      discovered('flux-new', { backend: ModelBackend.BFL, type: 'image', autoDisabledReason: PRICED_IN_BUILD_REASON }),
      catalogRow('anthropic.claude-x-v1:0', {
        id: 'anthropic.claude-x-v1:0',
        vendor: 'anthropic',
        backend: ModelBackend.Bedrock,
        type: 'text',
        name: 'Claude X',
        contextWindow: 200_000,
        lifecycle: { status: 'active' },
        disabled: true,
        disabledReason: BEDROCK_NOT_ON_DEMAND_REASON,
      }),
    ];
    const rows = await buildAdminModelRows(input({ adapterModels, catalogRows }));
    const page = adminModelListPage(rows, { filter: {}, pageSize: 500 });
    const shown = new Set([
      ...page.models.map(row => row.id),
      ...rows.filter(row => row.profileOnlyFoundation).map(row => row.id),
    ]);

    for (const id of [...adapterModels.map(model => String(model.id)), ...catalogRows.map(row => row.modelId)]) {
      expect(shown.has(id), id).toBe(true);
    }
    expect(page.foundationIds).toBe(1);
  });
});
