import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, NotFoundError } from '@bike4mind/common';

const { findById, resolveApiKeyBillingOrg } = vi.hoisted(() => ({
  findById: vi.fn(),
  resolveApiKeyBillingOrg: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ completionRunRepository: { findById } }));
vi.mock('@server/billing/apiKeyBillingOrg', () => ({ resolveApiKeyBillingOrg }));

import { resolvePaidCallRun } from './paidCallRun';

const RUN_ID = '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80';
const userRun = { runId: RUN_ID, userId: 'u1', ownerType: CreditHolderType.User, ownerId: 'u1' };
const orgRun = { runId: RUN_ID, userId: 'u1', ownerType: CreditHolderType.Organization, ownerId: 'org-1' };
const jwtReq = { user: { id: 'u1' } };
const orgKeyReq = { user: { id: 'u1' }, apiKeyInfo: { organizationId: 'org-1' } };

describe('resolvePaidCallRun', () => {
  beforeEach(() => {
    findById.mockReset();
    resolveApiKeyBillingOrg.mockReset().mockResolvedValue({ kind: 'not_org_billed' });
  });

  it('is undefined for a call made outside a run, without a lookup', async () => {
    expect(await resolvePaidCallRun(jwtReq, undefined)).toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
  });

  it("records the stored run id as a tool call, and bills the run's owner", async () => {
    findById.mockResolvedValue(userRun);

    const resolved = await resolvePaidCallRun(jwtReq, {
      runId: RUN_ID.toUpperCase(),
      role: 'worker',
      purpose: 'turn',
      taskId: 'task-a',
    });

    expect(resolved).toEqual({
      attribution: { runId: RUN_ID, role: 'worker', purpose: 'tool', taskId: 'task-a' },
      billingOrganizationId: null,
    });
  });

  it("bills an org-owned run's organization", async () => {
    findById.mockResolvedValue(orgRun);

    const resolved = await resolvePaidCallRun(orgKeyReq, { runId: RUN_ID, role: 'root' });

    expect(resolved?.billingOrganizationId).toBe('org-1');
  });

  it('refuses a run on a request with no signed-in user, without a lookup', async () => {
    await expect(resolvePaidCallRun({}, { runId: RUN_ID, role: 'root' })).rejects.toMatchObject({ statusCode: 401 });
    expect(findById).not.toHaveBeenCalled();
  });

  it("refuses another caller's run with the same 404 as a missing one", async () => {
    findById.mockResolvedValue({ ...userRun, userId: 'someone-else' });

    await expect(resolvePaidCallRun(jwtReq, { runId: RUN_ID, role: 'root' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a requested organization_id that is not the account the run bills', async () => {
    findById.mockResolvedValue(userRun);

    await expect(resolvePaidCallRun(jwtReq, { runId: RUN_ID, role: 'root' }, 'org-9')).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'billing_organization_mismatch' },
    });
  });

  it("checks an org-billed key against the run's account, as a call without a run would be", async () => {
    findById.mockResolvedValue(orgRun);
    resolveApiKeyBillingOrg.mockResolvedValue({ kind: 'org', organizationId: 'org-1' });

    await resolvePaidCallRun(orgKeyReq, { runId: RUN_ID, role: 'root' });

    expect(resolveApiKeyBillingOrg).toHaveBeenCalledWith({
      apiKeyInfo: orgKeyReq.apiKeyInfo,
      user: orgKeyReq.user,
      requestedOrgId: 'org-1',
    });
  });

  it("refuses an org-billed key whose holder has left the key's org", async () => {
    findById.mockResolvedValue(orgRun);
    resolveApiKeyBillingOrg.mockResolvedValue({ kind: 'stale', message: 'The key holder left the org' });

    await expect(resolvePaidCallRun(orgKeyReq, { runId: RUN_ID, role: 'root' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'The key holder left the org',
    });
  });

  it('refuses an org-billed key whose org is not the account the run bills', async () => {
    findById.mockResolvedValue(orgRun);
    resolveApiKeyBillingOrg.mockResolvedValue({ kind: 'mismatch', message: 'Different org' });

    await expect(resolvePaidCallRun(orgKeyReq, { runId: RUN_ID, role: 'root' })).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'billing_organization_mismatch' },
    });
  });

  it('accepts a requested organization_id that names the account the run bills', async () => {
    findById.mockResolvedValue(orgRun);

    const resolved = await resolvePaidCallRun(orgKeyReq, { runId: RUN_ID, role: 'root' }, 'org-1');

    expect(resolved?.billingOrganizationId).toBe('org-1');
  });
});
