import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { createBlockedSendToastGate, getSendBlockedLabel, getSendBlockedReason } from './sendBlockedReason';

const ready = {
  isGenerating: false,
  submitting: false,
  isModelsLoading: false,
  isModelsError: false,
  hasModels: true,
  isSocketOpen: true,
  hasActiveUploads: false,
};

describe('getSendBlockedReason', () => {
  it('allows a send when every gate is clear', () => {
    expect(getSendBlockedReason(ready)).toBeNull();
  });

  it.each([
    [{ isGenerating: true }, 'generating'],
    [{ submitting: true }, 'sending'],
    [{ isModelsLoading: true }, 'loadingModels'],
    [{ hasModels: false }, 'noModels'],
    [{ hasModels: false, isModelsError: true }, 'modelsError'],
    [{ isSocketOpen: false }, 'reconnecting'],
    [{ hasActiveUploads: true }, 'uploading'],
  ] as const)('blocks with %o -> %s', (override, reason) => {
    expect(getSendBlockedReason({ ...ready, ...override })).toBe(reason);
  });

  it('reports a live generation ahead of a dropped socket', () => {
    expect(getSendBlockedReason({ ...ready, isGenerating: true, isSocketOpen: false })).toBe('generating');
  });

  it('reports model loading ahead of an empty model list while models are still in flight', () => {
    expect(getSendBlockedReason({ ...ready, isModelsLoading: true, hasModels: false })).toBe('loadingModels');
  });

  it('ignores a stale models error once models are available', () => {
    expect(getSendBlockedReason({ ...ready, isModelsError: true })).toBeNull();
  });
});

describe('getSendBlockedLabel', () => {
  const t = ((_key: string, fallback: string) => fallback) as unknown as TFunction;

  it('tells a failed model load apart from a missing permission', () => {
    expect(getSendBlockedLabel('modelsError', t)).toBe("Couldn't load AI models");
    expect(getSendBlockedLabel('noModels', t)).toBe('No models available');
  });
});

describe('createBlockedSendToastGate', () => {
  it('toasts reasons the UI does not already show, once per window', () => {
    const shouldToast = createBlockedSendToastGate(3_000);
    expect(shouldToast('reconnecting', 1_000)).toBe(true);
    expect(shouldToast('reconnecting', 2_000)).toBe(false);
    expect(shouldToast('uploading', 2_000)).toBe(true);
    expect(shouldToast('reconnecting', 4_000)).toBe(true);
  });

  it('never toasts generating or sending', () => {
    const shouldToast = createBlockedSendToastGate();
    expect(shouldToast('generating', 0)).toBe(false);
    expect(shouldToast('sending', 0)).toBe(false);
  });
});
