import { describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { create } from './create';

const pendingOwner = {
  id: 'owner',
  email: 'owner@example.test',
  name: 'Owner',
  deletion: { requestedAt: new Date(), scheduledFor: new Date(), source: 'self' },
} as IUserDocument;

describe('organization creation during account deletion', () => {
  it.each([false, true])('refuses a pending owner before creating records (delegated: %s)', async delegated => {
    const createOrganization = vi.fn();
    const updateUser = vi.fn();
    const adapters = {
      db: {
        organizations: { create: createOrganization },
        users: { findById: vi.fn().mockResolvedValue(pendingOwner), update: updateUser },
      },
    } as unknown as Parameters<typeof create>[2];
    const caller = delegated ? ({ id: 'admin', isAdmin: true } as IUserDocument) : pendingOwner;

    await expect(
      create(
        caller,
        {
          name: 'Workspace',
          personal: false,
          seats: 1,
          stripeCustomerId: null,
          ...(delegated ? { billingOwnerId: pendingOwner.id } : {}),
        },
        adapters
      )
    ).rejects.toThrow('An account scheduled for deletion cannot own a new organization.');
    expect(createOrganization).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
