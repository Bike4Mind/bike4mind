import { describe, it, expect } from 'vitest';
import { getSendBlockedReason } from './sendBlockedReason';

const ready = {
  isGenerating: false,
  submitting: false,
  isModelsLoading: false,
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
});
