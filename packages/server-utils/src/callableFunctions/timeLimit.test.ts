// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsMap } from '@bike4mind/common';

const state = vi.hoisted(() => ({ seconds: [] as unknown[] }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => ['org-1', 'org-2']) },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    scopeForCaller: (caller: { userId: string; organizationId?: string }) => ({ owner: { id: caller.organizationId } }),
    resolveScopedSetting: vi.fn(async () => ({ value: state.seconds.shift(), source: 'organization' })),
  },
}));

const { resolveCallableFunctionPendingCallLimit, resolveCallableFunctionTimeLimitMs } = await import('./timeLimit');
const {
  CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
  CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS,
  CALLABLE_FUNCTION_START_BUDGET_MS,
} = await import('./runtimeParent');

describe('resolveCallableFunctionTimeLimitMs', () => {
  beforeEach(() => {
    state.seconds = [];
  });

  it('allows the setting exactly as many seconds as a queued call can run', () => {
    expect(settingsMap.CallableFunctionTimeLimitSeconds.max).toBe(CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS / 1000);
  });

  it('fits a queued run at the longest limit inside the runtime Lambda and the consumer that waits for it', () => {
    const runMs =
      CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS + CALLABLE_FUNCTION_START_BUDGET_MS + CALLABLE_FUNCTION_PARENT_MARGIN_MS;
    expect(runMs).toBeLessThanOrEqual(CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS * 1000);
    expect(runMs).toBeLessThan(CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS * 1000);
  });

  it('takes the lowest of the organizations', async () => {
    state.seconds = [300, 60];
    expect(await resolveCallableFunctionTimeLimitMs({ id: 'u1' })).toBe(60_000);
  });

  it('caps a stored value above what a queued call can run', async () => {
    state.seconds = [825, 900];
    expect(await resolveCallableFunctionTimeLimitMs({ id: 'u1' })).toBe(CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS);
  });
});

describe('resolveCallableFunctionPendingCallLimit', () => {
  it('takes the lowest of the organizations, and the default for one with no value', async () => {
    state.seconds = [4, 7];
    expect(await resolveCallableFunctionPendingCallLimit({ id: 'u1' })).toBe(4);
    state.seconds = [undefined, 50];
    expect(await resolveCallableFunctionPendingCallLimit({ id: 'u1' })).toBe(
      settingsMap.CallableFunctionPendingCallLimit.defaultValue
    );
  });
});
