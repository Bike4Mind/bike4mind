import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTools } from './toolGenerators';
import type { ToolContext, ToolDefinition } from './base/types';
import { memoizeOperationalBillingCheck } from '../../billing/isOperationalBillingEnabled';

vi.mock('../../billing/isOperationalBillingEnabled', () => ({
  memoizeOperationalBillingCheck: vi.fn(),
}));

describe('generateTools operational billing', () => {
  beforeEach(() => {
    vi.mocked(memoizeOperationalBillingCheck).mockReset();
  });

  it.each([true, false])('forwards the billing adapter and scopes its check when enabled=%s', enabled => {
    const billingCheck = vi.fn().mockResolvedValue(true);
    vi.mocked(memoizeOperationalBillingCheck).mockReturnValue(billingCheck);
    const db = {
      adminSettings: {},
      ...(enabled ? { operationalBilling: {} } : {}),
    } as ToolContext['db'];
    const logger = {} as ToolContext['logger'];
    const implementation = vi.fn<ToolDefinition['implementation']>().mockReturnValue({} as never);

    generateTools(
      'user-1',
      { id: 'user-1' } as ToolContext['user'],
      logger,
      { db, authOrigin: 'session', organizationId: 'active-org' },
      {} as never,
      {} as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {} as never,
      {},
      undefined,
      undefined,
      { probe: { name: 'probe', implementation } }
    );

    const context = implementation.mock.calls[0][0];
    expect(context.db).toBe(db);
    expect(context.organizationId).toBe('active-org');
    expect(context.operationalBillingCheck).toBe(enabled ? billingCheck : undefined);
    if (enabled) {
      expect(memoizeOperationalBillingCheck).toHaveBeenCalledExactlyOnceWith(
        { adminSettings: db.adminSettings },
        logger
      );
    } else {
      expect(memoizeOperationalBillingCheck).not.toHaveBeenCalled();
    }
  });
});
