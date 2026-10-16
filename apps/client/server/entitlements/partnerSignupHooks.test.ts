import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import {
  PARTNER_SIGNUP_HOOK_TIMEOUT_MS,
  runPartnerSignupHooks,
  type PartnerSignupHook,
  type PartnerSignupHookContext,
} from './partnerSignupHooks';

const makeContext = () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const context: PartnerSignupHookContext = {
    userId: 'user-1',
    rule: { id: 'rule-1', domain: 'partner.example', organizationId: null },
    joinedOrganizationId: null,
    trigger: 'otc-signup',
    // Only error is called.
    logger: logger as unknown as Logger,
  };
  return { context, logger };
};

describe('runPartnerSignupHooks', () => {
  it('runs every hook with the context', async () => {
    const { context } = makeContext();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    await runPartnerSignupHooks(
      [
        { name: 'first', run: first },
        { name: 'second', run: second },
      ],
      context
    );

    expect(first).toHaveBeenCalledWith(context);
    expect(second).toHaveBeenCalledWith(context);
  });

  it('logs a rejecting hook by name and still runs the others', async () => {
    const { context, logger } = makeContext();
    const healthy = vi.fn().mockResolvedValue(undefined);

    await runPartnerSignupHooks(
      [
        { name: 'broken', run: vi.fn().mockRejectedValue(new Error('overlay down')) },
        { name: 'healthy', run: healthy },
      ],
      context
    );

    expect(healthy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"broken"'), expect.any(Error));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('rule-1'), expect.any(Error));
  });

  it('contains a hook that throws synchronously', async () => {
    const { context, logger } = makeContext();
    const syncThrow: PartnerSignupHook = {
      name: 'sync-throw',
      run: () => {
        throw new Error('sync');
      },
    };

    await expect(runPartnerSignupHooks([syncThrow], context)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('sync-throw'), expect.any(Error));
  });

  it('logs a hook that never settles once its budget elapses, without holding the others', async () => {
    vi.useFakeTimers();
    try {
      const { context, logger } = makeContext();
      const healthy = vi.fn().mockResolvedValue(undefined);
      const pending = runPartnerSignupHooks(
        [
          { name: 'stalled', run: () => new Promise<void>(() => {}) },
          { name: 'healthy', run: healthy },
        ],
        context
      );

      await vi.advanceTimersByTimeAsync(PARTNER_SIGNUP_HOOK_TIMEOUT_MS);
      await pending;

      expect(healthy).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"stalled"'), expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op with no hooks registered', async () => {
    const { context, logger } = makeContext();

    await runPartnerSignupHooks([], context);

    expect(logger.error).not.toHaveBeenCalled();
  });
});
