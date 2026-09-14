import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { update } from './update';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('organizationService - update', () => {
  const mockAdminUser: Partial<IUserDocument> = {
    id: 'admin1',
    name: 'Admin User',
    email: 'admin@example.com',
    isAdmin: true,
  };

  const mockRegularUser: Partial<IUserDocument> = {
    id: 'user1',
    name: 'Regular User',
    email: 'user@example.com',
    isAdmin: false,
  };

  const existingOrganization: Partial<IOrganizationDocument> = {
    id: 'org1',
    name: 'Original Organization',
    description: 'Original description',
    billingContact: 'original@example.com',
    currentCredits: 1000,
    userId: 'user1',
    users: [],
    seats: 3,
    personal: false,
    userDetails: null,
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  let mockAdapters: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        organizations: {
          shareable: {
            findUpdateAccessById: vi.fn().mockResolvedValue(existingOrganization),
          },
          update: vi.fn().mockResolvedValue(undefined),
          findById: vi.fn().mockResolvedValue(existingOrganization),
        },
      },
    };
  });

  it('should update an organization with provided values when user is admin', async () => {
    const updateParams = {
      id: 'org1',
      name: 'Updated Organization',
      description: 'Updated description',
      billingContact: 'updated@example.com',
      currentCredits: 2000,
    };

    await update(mockRegularUser as IUserDocument, updateParams, mockAdapters);

    // Targeted write: only the caller-editable fields that changed. currentCredits
    // is admin-only, so a non-admin's value never reaches the write. Unchanged and
    // non-editable fields (seats, users, updatedAt) are not round-tripped.
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(persisted).toEqual({
      id: 'org1',
      name: 'Updated Organization',
      description: 'Updated description',
      billingContact: 'updated@example.com',
    });
  });

  it('should update only the provided fields and keep others unchanged', async () => {
    const updateParams = {
      id: 'org1',
      name: 'Updated Organization',
    };

    const result = await update(mockAdminUser as IUserDocument, updateParams, mockAdapters);

    expect(result).toEqual({
      ...existingOrganization,
      name: 'Updated Organization',
      updatedAt: expect.any(Date),
    });

    // Targeted write: only the changed field. Unchanged fields are left untouched in the
    // DB rather than round-tripped (which is what stops a concurrent write being reverted).
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(persisted).toEqual({ id: 'org1', name: 'Updated Organization' });
  });

  it('should throw NotFoundError when organization is not found', async () => {
    mockAdapters.db.organizations.shareable.findUpdateAccessById.mockResolvedValue(null);

    await expect(update(mockRegularUser as IUserDocument, { id: 'nonexistent-org' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should validate and secure parameters', async () => {
    await update(
      mockAdminUser as IUserDocument,
      {
        id: 'org1',
        name: 'Updated Organization',
        // @ts-ignore - Adding extra parameters to test parameter validation
        extraParam: 'should be ignored',
        seats: 10, // This should be ignored as it's not in the schema
      },
      mockAdapters
    );

    const updateCall = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(updateCall).toEqual({ id: 'org1', name: 'Updated Organization' });
    expect(updateCall).not.toHaveProperty('extraParam');
    // seats is not a caller-editable field, so it is never in the write - it stays 3 in the
    // DB because a targeted write leaves it untouched, not because it was round-tripped.
    expect(updateCall).not.toHaveProperty('seats');
  });

  it('should update currentCredits when provided by admin user', async () => {
    const updateParams = {
      id: 'org1',
      currentCredits: 5000,
    };

    const result = await update(mockAdminUser as IUserDocument, updateParams, mockAdapters);

    expect(result.currentCredits).toBe(5000);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        currentCredits: 5000,
      })
    );
  });

  it('should not update currentCredits when provided by non-admin user', async () => {
    const updateParams = {
      id: 'org1',
      currentCredits: 5000,
    };

    const result = await update(mockRegularUser as IUserDocument, updateParams, mockAdapters);

    expect(result.currentCredits).toBe(1000); // Original value

    // A non-admin's currentCredits never reaches the write at all (not round-tripped),
    // so a concurrent credit change cannot be reverted by this PUT.
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(persisted).not.toHaveProperty('currentCredits');
  });

  // Regression: findUpdateAccessById returns a HYDRATED Mongoose doc (unlike
  // findAccessibleById, which returns toJSON()). Spreading a hydrated doc copies
  // `_doc`/`$__` and nests the real fields, corrupting the shape AND defeating the
  // response-boundary strip (top-level stripeCustomerId/userId would be undefined).
  // update() must normalize to a plain object first. A plain-object mock cannot
  // catch this -- this test uses a real mongoose document.
  it('normalizes a hydrated Mongoose doc: no _doc/$__ leaks and fields stay top-level', async () => {
    const schema = new mongoose.Schema({
      name: String,
      userId: String,
      stripeCustomerId: String,
      billingContact: String,
      systemPrompt: String,
    });
    const Model = mongoose.models.OrgUpdateHydratedTest || mongoose.model('OrgUpdateHydratedTest', schema);
    const hydrated = new Model({
      name: 'Acme',
      userId: 'user1',
      stripeCustomerId: 'cus_SECRET',
      billingContact: 'b@a.com',
    });
    mockAdapters.db.organizations.shareable.findUpdateAccessById.mockResolvedValue(hydrated);

    const result = (await update(mockRegularUser as IUserDocument, { id: 'org1', name: 'Acme2' }, mockAdapters)) as any;

    // Hydrated-doc internals must not survive into the returned/persisted object.
    expect('_doc' in result).toBe(false);
    expect('$__' in result).toBe(false);
    // Real fields are top-level, so a response-boundary strip can act on them.
    expect(result.userId).toBe('user1');
    expect(result.stripeCustomerId).toBe('cus_SECRET');
    expect(result.name).toBe('Acme2');

    // The persisted write is a targeted partial built field-by-field, so hydrated
    // internals cannot leak and non-editable fields (userId) are never round-tripped.
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect('_doc' in persisted).toBe(false);
    expect('$__' in persisted).toBe(false);
    expect(persisted).toEqual({ id: 'org1', name: 'Acme2' });
  });

  it('sets a positive per-member cap when admin', async () => {
    const result = await update(mockAdminUser as IUserDocument, { id: 'org1', maxCreditsPerMember: 500 }, mockAdapters);

    expect(result.maxCreditsPerMember).toBe(500);
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org1', maxCreditsPerMember: 500 })
    );
  });

  it('clears the per-member cap to null (not undefined) so $set actually unsets it', async () => {
    // Regression: `?? undefined` left the old cap in place because BSON drops undefined from
    // `$set`, so a "set null" PUT silently no-oped. The cleared cap MUST persist as null.
    const cappedOrg = { ...existingOrganization, maxCreditsPerMember: 5 };
    mockAdapters.db.organizations.shareable.findUpdateAccessById.mockResolvedValue(cappedOrg);
    mockAdapters.db.organizations.findById.mockResolvedValue(cappedOrg);

    const result = await update(
      mockAdminUser as IUserDocument,
      { id: 'org1', maxCreditsPerMember: null },
      mockAdapters
    );

    expect(result.maxCreditsPerMember).toBeNull();
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(persisted.maxCreditsPerMember).toBeNull();
    expect(persisted.maxCreditsPerMember).not.toBeUndefined();
  });

  it('ignores a per-member cap change from a non-admin', async () => {
    const cappedOrg = { ...existingOrganization, maxCreditsPerMember: 5 };
    mockAdapters.db.organizations.shareable.findUpdateAccessById.mockResolvedValue(cappedOrg);

    const result = await update(
      mockRegularUser as IUserDocument,
      { id: 'org1', maxCreditsPerMember: 999 },
      mockAdapters
    );

    expect(result.maxCreditsPerMember).toBe(5); // unchanged
  });

  it('should allow non-admin users to update other fields but not currentCredits', async () => {
    const updateParams = {
      id: 'org1',
      name: 'Updated By Regular User',
      description: 'Updated description by regular user',
      billingContact: 'regular@example.com',
      currentCredits: 5000, // This should be ignored for non-admin users
    };

    const result = await update(mockRegularUser as IUserDocument, updateParams, mockAdapters);

    expect(result).toEqual({
      ...existingOrganization,
      name: 'Updated By Regular User',
      description: 'Updated description by regular user',
      billingContact: 'regular@example.com',
      currentCredits: 1000, // Original value, not 5000
      updatedAt: expect.any(Date),
    });

    // The write carries only the caller-editable fields the non-admin changed;
    // currentCredits is admin-only and never enters the write.
    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(persisted).toEqual({
      id: 'org1',
      name: 'Updated By Regular User',
      description: 'Updated description by regular user',
      billingContact: 'regular@example.com',
    });
    expect(persisted).not.toHaveProperty('currentCredits');
  });
});
