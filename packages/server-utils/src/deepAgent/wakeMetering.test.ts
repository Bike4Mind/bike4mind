import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepAgentStore } from '@bike4mind/agents';
import { ForbiddenError, spendFrozenError, type ModelInfo } from '@bike4mind/common';
import { AI_ACCESS_PENDING_REVIEW_MESSAGE } from '@bike4mind/services/userService/accountState';
import { Logger } from '@bike4mind/observability';

const state = vi.hoisted(() => ({ disabled: false, restricted: false, failure: undefined as Error | undefined }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  userRepository: { findById: async () => ({ id: 'owner', tags: [] }) },
}));
vi.mock('../billing/meterPlatformCompletion', async () => {
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
const model = { id: 'mission-model' } as unknown as ModelInfo;

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

  it('keeps a spend freeze as spend_frozen rather than a model refusal', async () => {
    const error = spendFrozenError({ scopeType: 'User', frozenAt: new Date('2026-11-01T00:00:00Z') });
    state.failure = error;
    const meter = await missionWakeMeter(store, 'mission', new Logger());

    await expect(meter(model, [], 100)).rejects.toBe(error);
  });

  it('leaves an infrastructure failure retryable', async () => {
    const error = new Error('database unavailable');
    state.failure = error;
    const meter = await missionWakeMeter(store, 'mission', new Logger());

    await expect(meter(model, [], 100)).rejects.toBe(error);
  });

  it('passes an account-standing refusal through unwrapped so the wake defers', async () => {
    const error = new ForbiddenError(AI_ACCESS_PENDING_REVIEW_MESSAGE);
    state.failure = error;
    const meter = await missionWakeMeter(store, 'mission', new Logger());

    await expect(meter(model, [], 100)).rejects.toBe(error);
  });
});
