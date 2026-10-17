import { describe, expect, it, vi } from 'vitest';
import type { LLMModelConfig, ModelInfo } from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { createModelAdmission, isUnpricedTextModel, loadModelConfigurations } from './modelAdmission';

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
