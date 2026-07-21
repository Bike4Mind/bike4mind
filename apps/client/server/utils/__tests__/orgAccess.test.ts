import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const mockFindById = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

import { verifyOrgAccess } from '../orgAccess';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const MANAGER = '650000000000000000000222';
const STRANGER = '650000000000000000000333';

const org = { id: ORG, userId: OWNER, managerId: MANAGER };

describe('verifyOrgAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(org);
  });

  it('rejects an invalid ObjectId without touching the DB', async () => {
    await expect(verifyOrgAccess({ id: OWNER, isAdmin: false }, 'not-an-object-id')).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('grants an admin access to any org', async () => {
    const result = await verifyOrgAccess({ id: STRANGER, isAdmin: true }, ORG);
    expect(result).toBe(org);
  });

  it('404s an admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgAccess({ id: STRANGER, isAdmin: true }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('grants the org owner', async () => {
    const result = await verifyOrgAccess({ id: OWNER, isAdmin: false }, ORG);
    expect(result).toBe(org);
  });

  it('grants the team manager', async () => {
    const result = await verifyOrgAccess({ id: MANAGER, isAdmin: false }, ORG);
    expect(result).toBe(org);
  });

  it('404s a non-member (same error as missing, to prevent enumeration)', async () => {
    await expect(verifyOrgAccess({ id: STRANGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s a non-admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgAccess({ id: OWNER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });
});
