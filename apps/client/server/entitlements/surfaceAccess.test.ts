import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementRequest } from '@server/entitlements';

const h = vi.hoisted(() => ({
  getRequestEntitlements: vi.fn(),
  copyEntitlements: { 'some-workspace': ['base:pro'] } as Record<string, string[]>,
}));

vi.mock('@server/entitlements', () => ({ getRequestEntitlements: h.getRequestEntitlements }));
vi.mock('@client/app/premium-generated/premiumWorkspaceCopyEntitlements.generated', () => ({
  get premiumWorkspaceCopyEntitlements() {
    return h.copyEntitlements;
  },
}));

import { copySurfaceAccessForRequest, surfaceAccessForRequest } from './surfaceAccess';

const req = { user: { isAdmin: false, tags: ['beta'] } } as unknown as EntitlementRequest;

beforeEach(() => {
  h.getRequestEntitlements.mockReset().mockResolvedValue(['base:pro']);
});

describe('surfaceAccessForRequest', () => {
  it("hands the session services the caller's grants and no copy grant table", async () => {
    await expect(surfaceAccessForRequest(req)()).resolves.toEqual({
      isAdmin: false,
      tags: ['beta'],
      entitlements: ['base:pro'],
    });
    expect(h.getRequestEntitlements).toHaveBeenCalledWith(req);
  });

  it('resolves no entitlements until called', () => {
    surfaceAccessForRequest(req);
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
  });
});

describe('copySurfaceAccessForRequest', () => {
  it("adds the build's copy grant table for the fork, snip and clone routes", async () => {
    await expect(copySurfaceAccessForRequest(req)()).resolves.toEqual({
      isAdmin: false,
      tags: ['beta'],
      entitlements: ['base:pro'],
      copyEntitlements: { 'some-workspace': ['base:pro'] },
    });
  });

  it('resolves no entitlements until called', () => {
    copySurfaceAccessForRequest(req);
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
  });
});
