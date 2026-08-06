import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntitlementRequest } from '@server/entitlements';

// Hoisted so the vi.mock factory (hoisted above imports) can reference it.
const { mockGetRequestEntitlements } = vi.hoisted(() => ({ mockGetRequestEntitlements: vi.fn() }));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: mockGetRequestEntitlements }));

import { toAccessContext } from './toAccessContext';

const req = (user: Record<string, unknown>) => ({ user }) as unknown as EntitlementRequest;
const HEX = '507f1f77bcf86cd799439011';

describe('toAccessContext - organizationId normalization (#1109 production fix site)', () => {
  beforeEach(() => {
    mockGetRequestEntitlements.mockReset();
    mockGetRequestEntitlements.mockResolvedValue([]);
  });

  it('coerces an ObjectId organizationId to its hex string (the real, reachable bug shape)', async () => {
    const ctx = await toAccessContext(req({ id: 'u1', tags: [], organizationId: { toHexString: () => HEX } }));
    expect(ctx.organizationId).toBe(HEX);
  });

  it('coerces a populated Organization document to its id', async () => {
    const ctx = await toAccessContext(
      req({ id: 'u1', tags: [], organizationId: { _id: { toHexString: () => HEX }, name: 'Acme' } })
    );
    expect(ctx.organizationId).toBe(HEX);
  });

  it('passes a plain string organizationId through unchanged', async () => {
    const ctx = await toAccessContext(req({ id: 'u1', tags: [], organizationId: HEX }));
    expect(ctx.organizationId).toBe(HEX);
  });

  it('leaves organizationId undefined when the user has none', async () => {
    const ctx = await toAccessContext(req({ id: 'u1', tags: [] }));
    expect(ctx.organizationId).toBeUndefined();
  });

  it('skips entitlement resolution for an admin (org id still normalized)', async () => {
    const ctx = await toAccessContext(
      req({ id: 'admin', isAdmin: true, tags: [], organizationId: { toHexString: () => HEX } })
    );
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.entitlementKeys).toEqual([]);
    expect(ctx.organizationId).toBe(HEX);
    expect(mockGetRequestEntitlements).not.toHaveBeenCalled();
  });
});
