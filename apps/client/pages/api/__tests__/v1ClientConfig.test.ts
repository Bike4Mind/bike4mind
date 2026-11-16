// @vitest-environment node
/**
 * Route tests for `GET /api/v1/client-config`.
 *
 * Same harness as v1Models.test.ts: `baseApi` is stubbed but `nextRouteForContract` is not, so
 * the contract's response drift check runs for real and the captured baseApi options are how the
 * auth + scope gate is asserted. Settings flow through the real getSettingsValue (defaults, the
 * enforceCredits lock); only the cached map read is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  ClientConfigResponseSchema,
  ModelBackend,
  settingsMap,
  userReadableSettingKeys,
  type ModelInfo,
} from '@bike4mind/common';

const { baseApiOptions, getCallerModelList, getSettingsMap, configuredSupportEmail } = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  getCallerModelList: vi.fn(),
  getSettingsMap: vi.fn(),
  configuredSupportEmail: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    return chain;
  },
}));

vi.mock('@server/utils/callerModelList', () => ({ getCallerModelList }));
vi.mock('sst', () => ({ Resource: { websocket: { url: 'wss://example.com/ws' } } }));
vi.mock('@server/utils/publicClientConfig', () => ({
  resolvePublicClientConfig: vi.fn(async () => ({
    api_url: 'https://example.com',
    default_theme: 'bike4mind',
    allow_open_registration: false,
    pyodide_base_url: '',
    allow_trusted_devices: true,
    turnstile_site_key: '',
    apple_sign_in_enabled: false,
    support_email: '',
  })),
}));
vi.mock('@server/auth/blockedSignIn', () => ({ configuredSupportEmail }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap,
}));

const { default: handler, config: routeConfig } = await import('@pages/api/v1/client-config');
const { default: publicHandler } = await import('@pages/api/v1/client-config/public');
const { CLIENT_CONFIG_FEATURE_SETTINGS } = await import('@server/utils/clientConfigFeatures');

const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function textModel(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend: ModelBackend.Anthropic,
    contextWindow: 200_000,
    max_tokens: 64_000,
    supportsTools: true,
    supportsImageVariation: false,
    pricing: { 200_000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
    rank: 1,
    adapterFamily: 'anthropic' as ModelInfo['adapterFamily'],
    ...overrides,
  };
}

/**
 * Stored values that must never reach the wire: a credential, operational config, and a
 * user-readable setting this endpoint deliberately does not publish. Each carries a marker the
 * leak assertion searches the serialized body for.
 */
const INTERNAL_SETTINGS: Record<string, string> = {
  openaiDemoKey: 'sk-LEAK-MARKER-credential',
  anthropicDemoKey: 'sk-ant-LEAK-MARKER-credential',
  adminNotificationEmail: 'LEAK-MARKER-ops@example.com',
  signupGrantInviteBonusCredits: '424242',
};

function get() {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'u1', isAdmin: false }, logger });
  return { req, res };
}

async function run(req: unknown, res: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  configuredSupportEmail.mockReturnValue('help@example.com');
  getSettingsMap.mockResolvedValue({
    ...INTERNAL_SETTINGS,
    EnableAgents: 'true',
    EnableDataLakes: 'false',
    MaxFileSize: '64',
    recommendedModelIds: JSON.stringify(['claude-opus-5', 'not-reachable', 'claude-sonnet-5']),
    DefaultAPIModel: 'claude-sonnet-5',
  });
  getCallerModelList.mockResolvedValue({
    models: [
      textModel('claude-opus-5'),
      textModel('claude-sonnet-5'),
      textModel('retired', { disabled: true }),
      textModel('transcribe', { type: 'speech-to-text', backend: ModelBackend.AWS }),
    ],
    supersededModels: [],
    lockedModels: [textModel('paid', { access: { locked: true, reason: 'requires_paid_plan' } })],
    modelListRevision: 'revision-1',
    catalogUnavailable: false,
  });
});

describe('GET /api/v1/client-config', () => {
  it('serves only the separate public projection before login', async () => {
    expect(baseApiOptions[1]).toMatchObject({ auth: false });
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { logger });
    await (publicHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(Object.keys(res._getJSONData()).sort()).toEqual([
      'allow_open_registration',
      'allow_trusted_devices',
      'api_url',
      'apple_sign_in_enabled',
      'default_theme',
      'pyodide_base_url',
      'support_email',
      'turnstile_site_key',
    ]);
    expect(getCallerModelList).not.toHaveBeenCalled();
    expect(getSettingsMap).not.toHaveBeenCalled();
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('requires authentication and admits me:read, ai:chat or ai:generate keys', () => {
    expect(routeConfig.bind).toContain('websocketApi');
    expect(baseApiOptions[0]).toMatchObject({
      auth: true,
      requiredScopes: [ApiKeyScope.ME_READ, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
      exemptReadsFromDailyRateLimit: true,
    });
  });

  it('returns the contract shape with stored settings applied', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ClientConfigResponseSchema.strict().safeParse(body).success).toBe(true);
    expect(body.server).toMatchObject({ status: 'live', support_email: 'help@example.com' });
    expect(body.features.agents).toBe(true);
    expect(body.features.data_lakes).toBe(false);
    expect(body.limits.max_upload_size_mb).toBe(64);
    expect(getCallerModelList).toHaveBeenCalledWith({ id: 'u1', isAdmin: false }, logger);
  });

  it('falls back to setting defaults when nothing is stored', async () => {
    getSettingsMap.mockResolvedValue({});
    const { req, res } = get();

    await run(req, res);

    const body = res._getJSONData();
    expect(body.features.artifacts).toBe(settingsMap.EnableArtifacts.defaultValue);
    expect(body.limits.max_upload_size_mb).toBe(settingsMap.MaxFileSize.defaultValue);
    expect(body.limits.low_credits_threshold).toBe(settingsMap.lowCreditsThreshold.defaultValue);
    expect(body.models.default_id).toBe(settingsMap.DefaultAPIModel.defaultValue);
  });

  it('reports a stored maintenance status, and reads an off-enum row as the setting default', async () => {
    getSettingsMap.mockResolvedValue({ serverStatus: 'maintenance' });
    let { req, res } = get();
    await run(req, res);
    expect(res._getJSONData().server.status).toBe('maintenance');

    getSettingsMap.mockResolvedValue({ serverStatus: 'rebooting' });
    ({ req, res } = get());
    await run(req, res);
    expect(res._getJSONData().server.status).toBe(settingsMap.serverStatus.defaultValue);
  });

  it('publishes a null support email when the deployment has none', async () => {
    configuredSupportEmail.mockReturnValue(undefined);
    const { req, res } = get();
    await run(req, res);
    expect(res._getJSONData().server.support_email).toBeNull();
  });

  it('lists only callable models, as the public projection, ordered by id', async () => {
    const { req, res } = get();

    await run(req, res);

    const { models } = res._getJSONData();
    expect(models.available.map((model: { id: string }) => model.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(models.default_id).toBe('claude-sonnet-5');
    // Admin order kept; an id the caller cannot reach is dropped.
    expect(models.recommended_ids).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    for (const model of models.available) {
      expect(model).not.toHaveProperty('pricing');
      expect(model).not.toHaveProperty('adapterFamily');
      expect(model).not.toHaveProperty('rank');
    }
  });

  it('never leaks a stored setting it does not explicitly publish', async () => {
    const { req, res } = get();

    await run(req, res);

    const serialized = JSON.stringify(res._getJSONData());
    expect(serialized).not.toContain('LEAK-MARKER');
    expect(serialized).not.toContain('424242');
  });

  it("publishes only settings a non-admin can already read, so it widens no one's view", async () => {
    const { req, res } = get();
    await run(req, res);
    const body = res._getJSONData();

    // Exact key sets: a new field is a deliberate schema change, never a pass-through.
    expect(Object.keys(body).sort()).toEqual([
      'catalog',
      'features',
      'limits',
      'models',
      'public_config',
      'server',
      'transport',
    ]);
    expect(Object.keys(body.limits).sort()).toEqual([
      'credits_enforced',
      'low_credits_threshold',
      'max_upload_size_mb',
    ]);

    expect(Object.keys(body.features).sort()).toEqual(Object.keys(CLIENT_CONFIG_FEATURE_SETTINGS).sort());

    // serverStatus is already public (unauthenticated /api/settings/serverStatus); DefaultAPIModel is publicSafe.
    const published = [
      ...Object.values(CLIENT_CONFIG_FEATURE_SETTINGS),
      'MaxFileSize',
      'enforceCredits',
      'lowCreditsThreshold',
      'recommendedModelIds',
      'DefaultAPIModel',
    ];
    const userReadable = new Set(userReadableSettingKeys());
    expect(published.filter(key => !userReadable.has(key))).toEqual([]);
  });

  it('is never cacheable by a shared cache', async () => {
    const { req, res } = get();
    await run(req, res);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('preserves picker availability, locks and revision without internal fields', async () => {
    const { req, res } = get();
    await run(req, res);
    const body = res._getJSONData();
    expect(body.catalog.models.map((model: { id: string }) => model.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'retired',
      'transcribe',
    ]);
    expect(body.catalog.models[2]).toMatchObject({ disabled: true });
    expect(body.catalog.locked_models[0].access).toEqual({ locked: true, reason: 'requires_paid_plan' });
    expect(body.catalog.model_list_revision).toBe('revision-1');
    expect(body.catalog.catalog_unavailable).toBe(false);
    expect(body.transport).toEqual({ websocket_url: 'wss://example.com/ws', sse_completions_url: '' });
    for (const model of [...body.catalog.models, ...body.catalog.locked_models]) {
      expect(model).not.toHaveProperty('pricing');
      expect(model).not.toHaveProperty('adapterFamily');
      expect(model).not.toHaveProperty('rank');
    }
  });

  it('preserves catalog fallback and superseded pins', async () => {
    getCallerModelList.mockResolvedValue({
      models: [],
      lockedModels: [],
      modelListRevision: null,
      catalogUnavailable: true,
      supersededModels: [{ id: 'old', name: 'Old', replacementId: 'new', replacementName: 'New' }],
    });
    const { req, res } = get();
    await run(req, res);
    expect(res._getJSONData().catalog).toMatchObject({
      model_list_revision: null,
      catalog_unavailable: true,
      superseded_models: [{ id: 'old', name: 'Old', replacement_id: 'new', replacement_name: 'New' }],
    });
  });
});
