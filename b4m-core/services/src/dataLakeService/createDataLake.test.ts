import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { buildDatalakeTag, createDataLake, isDatalakeTagWellFormed } from './createDataLake';

describe('isDatalakeTagWellFormed (trap 4: org-qualified vs plain datalake tag)', () => {
  it('accepts the org-qualified form for an org lake', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:org1:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      true
    );
  });

  it('accepts the PLAIN form for an org lake (promoted org-less -> org keeps its original tag)', () => {
    // setLakeVisibility deliberately does not re-mint the tag on promotion, so an org lake can still
    // carry datalake:<slug>. Without tolerance it would silently drop off the owner-exemption path.
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      true
    );
  });

  it('accepts the plain form for an org-less lake', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:sales', slug: 'sales', organizationId: undefined })).toBe(
      true
    );
  });

  it('rejects a tag that is neither the org-qualified nor the plain form of its slug', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:other', slug: 'sales', organizationId: 'org1' })).toBe(
      false
    );
    // A different org qualifier is not well-formed either (globally-unique tag, so this is a mismatch).
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:org2:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      false
    );
  });

  it('agrees with buildDatalakeTag for both scopes', () => {
    expect(buildDatalakeTag('sales', 'org1')).toBe('datalake:org1:sales');
    expect(buildDatalakeTag('sales')).toBe('datalake:sales');
  });
});

describe('createDataLake seeds an owner access grant', () => {
  const makeDb = () => {
    const created = { id: 'newLakeId', createdByUserId: 'creator' } as IDataLakeDocument;
    const upsertGrant = vi.fn(async () => ({}) as never);
    return {
      upsertGrant,
      db: {
        dataLakes: {
          find: vi.fn(async () => []), // no slug / prefix collisions
          create: vi.fn(async () => created),
        },
        dataLakeAccessGrants: { upsertGrant },
      },
    };
  };

  const params = { name: 'Sales', slug: 'sales', fileTagPrefix: 'sl:' } as Parameters<typeof createDataLake>[1];

  it('seeds an owner grant for the creator on the new lake', async () => {
    const { db, upsertGrant } = makeDb();
    await createDataLake('creator', params, { db } as never);
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'newLakeId',
        principalType: 'user',
        principalId: 'creator',
        role: 'owner',
        grantedByUserId: 'creator',
      })
    );
  });

  it('still returns the created lake when the grant seed fails (best-effort, logged)', async () => {
    const { db } = makeDb();
    db.dataLakeAccessGrants.upsertGrant = vi.fn(async () => {
      throw new Error('grant write failed');
    });
    const logger = { warn: vi.fn() };
    const lake = await createDataLake('creator', params, { db, logger } as never);
    expect(lake).toEqual(expect.objectContaining({ id: 'newLakeId' }));
    expect(logger.warn).toHaveBeenCalled();
  });
});
