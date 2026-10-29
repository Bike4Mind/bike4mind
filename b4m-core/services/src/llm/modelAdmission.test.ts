import { describe, expect, it, vi } from 'vitest';
import {
  ChatModels,
  ModelBackend,
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  PAID_PLAN_ENTITLEMENT_KEY,
  ServiceUnavailableError,
  type LLMModelConfig,
  type ModelInfo,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, getLlmWithFallback } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  createModelAdmission,
  isFreeTierModel,
  isUnpricedTextModel,
  loadFreeTierAllowedModels,
  loadModelConfigurations,
} from './modelAdmission';

const { getSettingsMap } = vi.hoisted(() => ({ getSettingsMap: vi.fn() }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap,
}));

const priced = {
  id: 'priced',
  type: 'text',
  pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
} as unknown as ModelInfo;
const unpriced = { id: 'unpriced', type: 'text', pricing: {} } as unknown as ModelInfo;
const free = {
  id: 'free',
  type: 'text',
  freeToRun: true,
  pricing: { 1: { input: 0, output: 0 } },
} as unknown as ModelInfo;
const disabled = { ...priced, id: 'disabled', disabled: true, disabledReason: 'gated' } as ModelInfo;
const image = { id: 'img', type: 'image', pricing: {} } as unknown as ModelInfo;
const models = [priced, unpriced, free, disabled, image];

const gated: LLMModelConfig = { id: 'priced', enabled: true, allowedEntitlements: ['pro'] } as LLMModelConfig;

describe('createModelAdmission', () => {
  it('admits a model with no config entry', async () => {
    await expect(createModelAdmission({ user: {}, configs: [] }).assert('anything')).resolves.toBeUndefined();
  });

  it('refuses a disabled catalog model with a 400 naming the reason', async () => {
    const err = await createModelAdmission({ user: { isAdmin: true }, configs: [], models })
      .assert('disabled')
      .catch(e => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain('gated');
  });

  it('refuses a non-entitled user with a 403 and admits an entitled one or an admin', async () => {
    const none = createModelAdmission({ user: { tags: [] }, configs: [gated], getEntitlements: async () => [] });
    await expect(none.assert('priced')).rejects.toBeInstanceOf(ForbiddenError);
    const entitled = createModelAdmission({
      user: { tags: [] },
      configs: [gated],
      getEntitlements: async () => ['pro'],
    });
    await expect(entitled.assert('priced')).resolves.toBeUndefined();
    const admin = createModelAdmission({ user: { isAdmin: true }, configs: [gated] });
    await expect(admin.admits('priced')).resolves.toBe(true);
  });

  it('resolves entitlements once, only when they can change the outcome, and fails safe to none', async () => {
    const getEntitlements = vi.fn().mockRejectedValue(new Error('db down'));
    const admission = createModelAdmission({
      user: { tags: [] },
      configs: [gated, { id: 'open', enabled: true } as LLMModelConfig],
      getEntitlements,
    });
    await expect(admission.admits('open')).resolves.toBe(false);
    expect(getEntitlements).not.toHaveBeenCalled();
    await expect(admission.admits('priced')).resolves.toBe(false);
    await expect(admission.admits('priced')).resolves.toBe(false);
    expect(getEntitlements).toHaveBeenCalledTimes(1);
  });

  it('refuses an unpriced text model only while credits are enforced', async () => {
    const on = createModelAdmission({ user: { isAdmin: true }, configs: [], models, enforceCredits: true });
    await expect(on.assert('unpriced')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(on.admits('free')).resolves.toBe(true);
    await expect(on.admits('img')).resolves.toBe(true);
    const off = createModelAdmission({ user: {}, configs: [], models, enforceCredits: false });
    await expect(off.admits('unpriced')).resolves.toBe(true);
  });

  it('refuses every model for a moderated user, even an admin, from both assert and admits', async () => {
    const admission = createModelAdmission({ user: { isAdmin: true, isModerated: true }, configs: [] });
    const err = await admission.assert('anything').catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain('AI features are disabled');
    await expect(admission.admits('anything')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admits as usual once moderation is lifted', async () => {
    const admission = createModelAdmission({ user: { isModerated: false }, configs: [] });
    await expect(admission.admits('anything')).resolves.toBe(true);
  });
});

describe('isUnpricedTextModel', () => {
  it('flags a text model with a missing or zero price that is not freeToRun', () => {
    expect(isUnpricedTextModel(unpriced)).toBe(true);
    expect(isUnpricedTextModel({ ...priced, pricing: { 1: { input: 0, output: 0 } } } as ModelInfo)).toBe(true);
    expect(isUnpricedTextModel(priced)).toBe(false);
    expect(isUnpricedTextModel(free)).toBe(false);
    expect(isUnpricedTextModel({ id: 'local', type: 'text', freeToRun: true } as unknown as ModelInfo)).toBe(false);
    expect(isUnpricedTextModel(image)).toBe(false);
  });
});

describe('loadModelConfigurations', () => {
  it('reads the setting and falls back to none on a read failure', async () => {
    const configs = [gated];
    await expect(loadModelConfigurations({ findOne: async () => ({ settingValue: configs }) } as any)).resolves.toBe(
      configs
    );
    await expect(loadModelConfigurations({ findOne: () => Promise.reject(new Error('x')) } as any)).resolves.toEqual(
      []
    );
  });
});

describe('loadModelConfigurations failure logging', () => {
  it('warns with the error and still returns no configs on a rejected read', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const failure = new Error('db down');
    await expect(
      loadModelConfigurations({ findOne: () => Promise.reject(failure) } as unknown as Parameters<
        typeof loadModelConfigurations
      >[0])
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read failed'), failure);
    warn.mockRestore();
  });
});

describe('free-tier model gate', () => {
  const allowlist = new Set(['priced']);
  const premium = { ...priced, id: 'premium' } as ModelInfo;
  const catalog = [priced, premium, image];
  const freeUser = (getEntitlements: () => Promise<string[]> = async () => ['base']) =>
    createModelAdmission({
      user: { tags: [] },
      configs: [],
      models: catalog,
      freeTierAllowedModels: allowlist,
      getEntitlements,
    });

  it('refuses a free account a text model outside the allowlist with model_requires_subscription', async () => {
    const err = await freeUser()
      .assert('premium')
      .catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.additionalInfo).toEqual({ errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE });
    expect(err.message).toContain('paid plan');
  });

  it('reports a paid-only model as not admitted, without throwing, so a fallback skips it', async () => {
    await expect(freeUser().admits('premium')).resolves.toBe(false);
  });

  it('admits a free account an allowlisted model', async () => {
    const admission = freeUser();
    await expect(admission.admits('priced')).resolves.toBe(true);
    await expect(admission.admits('img')).resolves.toBe(false);
  });

  it('gates an id missing from the catalog', async () => {
    await expect(freeUser().admits('not-in-catalog')).resolves.toBe(false);
  });

  it('admits a paid account every model', async () => {
    await expect(freeUser(async () => ['base', PAID_PLAN_ENTITLEMENT_KEY]).admits('premium')).resolves.toBe(true);
  });

  it('exempts admins and developers without resolving entitlements', async () => {
    const getEntitlements = vi.fn(async () => []);
    for (const user of [{ isAdmin: true }, { tags: ['Developer'] }]) {
      const admission = createModelAdmission({
        user,
        configs: [],
        models: catalog,
        freeTierAllowedModels: allowlist,
        getEntitlements,
      });
      await expect(admission.admits('premium')).resolves.toBe(true);
    }
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it('fails closed when entitlements cannot be resolved', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    await expect(freeUser(() => Promise.reject(new Error('db down'))).admits('premium')).resolves.toBe(false);
    warn.mockRestore();
  });

  it('answers a failed entitlement read with a retryable 503, not the subscription refusal, and logs once', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const admission = freeUser(() => Promise.reject(new Error('db down')));
    const err = await admission.assert('premium').catch(e => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.additionalInfo?.errorCode).not.toBe(MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE);
    expect(err.message).toContain('Please try again');
    await expect(admission.admits('premium')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still admits an allowlisted model when the entitlement read fails', async () => {
    const getEntitlements = vi.fn(() => Promise.reject(new Error('db down')));
    await expect(freeUser(getEntitlements).admits('priced')).resolves.toBe(true);
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it('lands a free user on an allowlisted fallback when the primary is paid-only', async () => {
    const text = (id: string) =>
      ({
        id,
        name: id,
        type: 'text',
        backend: ModelBackend.Anthropic,
        pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
      }) as unknown as ModelInfo;
    const paidOnly = text('paid-only');
    const otherPaid = text('other-paid');
    const allowlisted = text('allowlisted');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const admission = createModelAdmission({
      user: { tags: [] },
      configs: [],
      models: [paidOnly, otherPaid, allowlisted],
      freeTierAllowedModels: new Set(['allowlisted']),
      getEntitlements: async () => ['base'],
    });

    const result = await getLlmWithFallback(
      paidOnly,
      undefined,
      [paidOnly, otherPaid, allowlisted],
      { anthropic: 'valid-key' } as Record<string, string>,
      logger,
      { forceSwitch: true, isAdmitted: admission.admits }
    );

    expect(result?.model.id).toBe('allowlisted');
  });

  it('admits every model while the gate is off', async () => {
    const admission = createModelAdmission({ user: { tags: [] }, configs: [], models: catalog });
    await expect(admission.admits('premium')).resolves.toBe(true);
  });
});

describe('free-tier media admission', () => {
  it.each(['image', 'video', 'speech-to-text'] as const)(
    'requires a paid plan for an unlisted %s model before any credits can be spent',
    async type => {
      const model = { ...image, id: `premium-${type}`, type } as ModelInfo;
      const allowedModels = new Set(['priced']);
      expect(isFreeTierModel(model.id, allowedModels)).toBe(false);
      const admission = createModelAdmission({
        user: {},
        configs: [],
        models: [model],
        freeTierAllowedModels: allowedModels,
        getEntitlements: async () => ['base'],
      });
      await expect(admission.admits(model.id)).resolves.toBe(false);
      await expect(admission.assert(model.id)).rejects.toMatchObject({
        additionalInfo: { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE },
      });
      expect(isFreeTierModel(model.id, new Set([model.id]))).toBe(true);
      await expect(
        createModelAdmission({
          user: {},
          configs: [],
          models: [model],
          freeTierAllowedModels: new Set([model.id]),
        }).assert(model.id)
      ).resolves.toBeUndefined();
      await expect(
        createModelAdmission({
          user: {},
          configs: [],
          models: [model],
          freeTierAllowedModels: allowedModels,
          getEntitlements: async () => [PAID_PLAN_ENTITLEMENT_KEY],
        }).assert(model.id)
      ).resolves.toBeUndefined();
    }
  );
});

describe('loadFreeTierAllowedModels', () => {
  const adminSettings = {} as Parameters<typeof loadFreeTierAllowedModels>[0];

  it('is undefined while the gate is off', async () => {
    getSettingsMap.mockResolvedValueOnce({ freeTierModelGateEnabled: 'false' });
    await expect(loadFreeTierAllowedModels(adminSettings)).resolves.toBeUndefined();
  });

  it('returns only the allowlist while the gate is on, never the Default API Model', async () => {
    getSettingsMap.mockResolvedValueOnce({
      freeTierModelGateEnabled: 'true',
      freeTierAllowedModels: JSON.stringify(['cheap']),
      DefaultAPIModel: ChatModels.CLAUDE_5_5_OPUS,
    });
    await expect(loadFreeTierAllowedModels(adminSettings)).resolves.toEqual(new Set(['cheap']));
  });

  it('propagates a settings read failure instead of opening the gate', async () => {
    getSettingsMap.mockRejectedValueOnce(new Error('db down'));
    await expect(loadFreeTierAllowedModels(adminSettings)).rejects.toThrow('db down');
  });
});
