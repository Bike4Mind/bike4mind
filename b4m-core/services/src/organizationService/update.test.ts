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

    // Mock the current date for updatedAt
    const mockDate = new Date('2023-02-01T00:00:00.000Z');
    const originalDate = global.Date;
    global.Date = vi.fn(function () {
      return mockDate;
    }) as any;
    global.Date.now = originalDate.now;

    try {
        await update(mockRegularUser as IUserDocument, updateParams, mockAdapters);

        expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ...existingOrganization,
          id: 'org1',
          name: 'Updated Organization',
          description: 'Updated description',
          billingContact: 'updated@example.com',
          updatedAt: mockDate,
        })
      );
    } finally {
      global.Date = originalDate;
    }
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

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        name: 'Updated Organization',
        description: 'Original description', // Unchanged
        billingContact: 'original@example.com', // Unchanged
        currentCredits: 1000, // Unchanged
      })
    );
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

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        name: 'Updated Organization',
      })
    );

    const updateCall = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect(updateCall).not.toHaveProperty('extraParam');
    expect(updateCall.seats).toBe(3); // Original value, not 10
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

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        currentCredits: 1000, // Original value, not 5000
      })
    );
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

    const persisted = mockAdapters.db.organizations.update.mock.calls[0][0];
    expect('_doc' in persisted).toBe(false);
    expect(persisted.userId).toBe('user1');
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

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        name: 'Updated By Regular User',
        description: 'Updated description by regular user',
        billingContact: 'regular@example.com',
        currentCredits: 1000, // Original value, not 5000
      })
    );
  });
});
