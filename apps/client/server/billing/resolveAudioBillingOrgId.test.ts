import { CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMediaBillingOrgId } = vi.hoisted(() => ({ resolveMediaBillingOrgId: vi.fn() }));

vi.mock('./resolveMediaBillingOrgId', () => ({
  resolveMediaBillingOrgId: (...a: unknown[]) => resolveMediaBillingOrgId(...a),
}));
vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {
    statusCode = 403;
    constructor(
      message?: string,
      public additionalInfo?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

import { resolveAudioBillingOrgId } from './resolveAudioBillingOrgId';

type Req = Parameters<typeof resolveAudioBillingOrgId>[0];

const jwtReq = { user: { id: 'u1' }, logger: {} } as unknown as Req;
const keyReq = (apiKeyInfo: NonNullable<Req['apiKeyInfo']>) =>
  ({ user: { id: 'u1' }, logger: {}, apiKeyInfo }) as unknown as Req;
const orgKey = (organizationId?: string | null) =>
  keyReq({
    billingOwnerType: CreditHolderType.Organization,
    organizationId,
  } as NonNullable<Req['apiKeyInfo']>);

beforeEach(() => {
  resolveMediaBillingOrgId.mockReset();
  resolveMediaBillingOrgId.mockResolvedValue('resolvedOrg');
});

describe('resolveAudioBillingOrgId', () => {
  it('bills the user without consulting the resolver when a user-default route gets nothing', async () => {
    expect(await resolveAudioBillingOrgId(jwtReq, undefined, 'user')).toBeNull();
    expect(resolveMediaBillingOrgId).not.toHaveBeenCalled();
  });

  it('delegates an omitted value on a home-org route, so a stale pointer degrades as before', async () => {
    expect(await resolveAudioBillingOrgId(jwtReq, undefined, 'home-org')).toBe('resolvedOrg');
    expect(resolveMediaBillingOrgId).toHaveBeenCalledWith(jwtReq, undefined);
  });

  it('delegates an explicit org or personal choice for a JWT caller', async () => {
    expect(await resolveAudioBillingOrgId(jwtReq, 'teamOrg', 'home-org')).toBe('resolvedOrg');
    expect(resolveMediaBillingOrgId).toHaveBeenCalledWith(jwtReq, 'teamOrg');

    resolveMediaBillingOrgId.mockResolvedValue(null);
    expect(await resolveAudioBillingOrgId(jwtReq, null, 'home-org')).toBeNull();
    expect(resolveMediaBillingOrgId).toHaveBeenCalledWith(jwtReq, null);
  });

  it('bills an org-billed key to its own org when it names it, or names nothing', async () => {
    expect(await resolveAudioBillingOrgId(orgKey('orgA'), 'orgA', 'home-org')).toBe('resolvedOrg');
    expect(resolveMediaBillingOrgId).toHaveBeenCalledWith(orgKey('orgA'), 'orgA');

    expect(await resolveAudioBillingOrgId(orgKey('orgA'), undefined, 'home-org')).toBe('resolvedOrg');
    expect(resolveMediaBillingOrgId).toHaveBeenLastCalledWith(orgKey('orgA'), 'orgA');
  });

  it('refuses an org-billed key naming another org, or personal', async () => {
    const req = orgKey('orgA');
    await expect(resolveAudioBillingOrgId(req, 'orgB', 'home-org')).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'billing_organization_mismatch' },
    });
    await expect(resolveAudioBillingOrgId(req, null, 'home-org')).rejects.toMatchObject({ statusCode: 403 });
    expect(resolveMediaBillingOrgId).not.toHaveBeenCalled();
  });

  it('propagates the resolver refusal for a key whose org is gone or whose holder left it', async () => {
    resolveMediaBillingOrgId.mockRejectedValue(new Error('Re-mint the key'));
    await expect(resolveAudioBillingOrgId(orgKey('orgA'), undefined, 'home-org')).rejects.toThrow('Re-mint');
  });

  it('bills a user-billed key to the user for personal or omitted, whatever its org seat', async () => {
    const req = keyReq({ billingOwnerType: CreditHolderType.User } as NonNullable<Req['apiKeyInfo']>);
    expect(await resolveAudioBillingOrgId(req, null, 'home-org')).toBeUndefined();
    expect(await resolveAudioBillingOrgId(req, undefined, 'user')).toBeUndefined();
    expect(resolveMediaBillingOrgId).not.toHaveBeenCalled();
  });

  it('refuses a user-billed key that names an organization', async () => {
    const req = keyReq({ billingOwnerType: CreditHolderType.User } as NonNullable<Req['apiKeyInfo']>);
    await expect(resolveAudioBillingOrgId(req, 'orgB', 'home-org')).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'billing_organization_mismatch' },
    });
  });

  it('treats an org-billed key with no organization id as user-billed, never as personal-org', async () => {
    // Minting sets both together; this guards the wire shape rather than a reachable state.
    const req = keyReq({ billingOwnerType: CreditHolderType.Organization } as NonNullable<Req['apiKeyInfo']>);
    expect(await resolveAudioBillingOrgId(req, undefined, 'home-org')).toBeUndefined();
  });
});
