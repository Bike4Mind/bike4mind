import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepAgentStore } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const state = vi.hoisted(() => ({ disabled: false, restricted: false, failure: undefined as Error | undefined }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  userRepository: { findById: async () => ({ id: 'owner', tags: [] }) },
}));
vi.mock('@server/billing/meterPlatformCompletion', async () => {
  const { createModelAdmission } = await import('@bike4mind/services/llm/modelAdmission');
  return {
    assertOwnerCanAfford: vi.fn(),
    completionCeilingUsd: vi.fn(),
    isCreditsEnforced: vi.fn(),
    createCompletionMeter: () => async (model: ModelInfo) => {
      if (state.failure) throw state.failure;
      const admission = createModelAdmission({
        user: { tags: [] },
        models: [{ ...model, disabled: state.disabled }],
        configs: state.restricted ? [{ ...model, enabled: true, allowedUserTags: ['vip'] }] : [],
      });
      await admission.assert(model.id);
      return { refund: async () => {}, settle: async () => 0 };
    },
  };
});

import { missionWakeMeter, MissionModelRefusedError } from './wakeMetering';

const store = {
  loadCharter: async () => ({ identity: { ownerUserId: 'owner' } }),
} as unknown as DeepAgentStore;
const model = { id: 'mission-model' } as ModelInfo;

beforeEach(() => {
  state.disabled = false;
  state.restricted = false;
  state.failure = undefined;
});

describe('missionWakeMeter admission refusals', () => {
  it.each(['disabled', 'restricted'] as const)(
    'classifies a %s model as a permanent mission refusal',
    async refusal => {
      state[refusal] = true;
      const meter = await missionWakeMeter(store, 'mission', new Logger());

      await expect(meter(model, [], 100)).rejects.toBeInstanceOf(MissionModelRefusedError);
    }
  );

  it('leaves an infrastructure failure retryable', async () => {
    const error = new Error('database unavailable');
    state.failure = error;
    const meter = await missionWakeMeter(store, 'mission', new Logger());

    await expect(meter(model, [], 100)).rejects.toBe(error);
  });
});
