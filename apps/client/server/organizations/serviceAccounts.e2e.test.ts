import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  Organization,
  UserApiKey,
  Project,
  CreditTransaction,
  userApiKeyRepository,
  organizationRepository,
  userRepository,
  creditTransactionRepository,
} from '@bike4mind/database';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import { userApiKeyService, creditService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { assertOrgServiceAccountRequest } from '@bike4mind/server-utils/auth/orgServiceAccount';
import { assertApiKeyOrgMembership } from '@bike4mind/server-utils/billing/assertApiKeyOrgMembership';
import { attributeToRequestApiKey } from '@bike4mind/server-utils/billing/attributeToRequestApiKey';
import { resolveRequestBillingOrgId } from '@bike4mind/server-utils/billing/resolveRequestBillingOrgId';
import { OrganizationAuditEventModel } from '@bike4mind/database/infra';

vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({ assertApiKeyAccessAllowed: vi.fn() }));
import { createServiceKey, resolveServiceKey } from './serviceAccounts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let stop: () => Promise<unknown>;
beforeAll(async () => {
  const server = await createMongoReplSet();
  stop = () => server.stop();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await stop?.();
});

describe('persisted non-seat service key lifecycle', () => {
  it('survives creator removal/deletion and rotates without changing its principal', async () => {
    const creator = await User.create({ name: 'creator', username: 'creator', email: null, isAdmin: false });
    const owner = await User.create({ name: 'owner', username: 'owner', email: null, isAdmin: false });
    const org = await Organization.create({
      name: 'team',
      userId: owner.id,
      seats: 3,
      currentCredits: 100,
      users: [{ userId: creator.id, permissions: ['read', 'update'] }],
      adminUserIds: [creator.id],
    });
    const input = {
      name: 'automation',
      scopes: [ApiKeyScope.AI_CHAT],
      grants: [{ resourceType: 'organization', resourceId: org.id, permission: 'compute' }],
    };
    const minted = await createServiceKey(creator, org.id, input);
    const principal = await User.findById(minted.principalId).orFail();
    expect(principal.isSystem).toBe(true);
    expect(principal.isAdmin).toBe(false);
    expect(principal.organizationId).toBeNull();
    const unchanged = await Organization.findById(org.id).orFail();
    expect(unchanged.seats).toBe(3);
    expect(unchanged.users.map(row => row.userId.toString())).toEqual([creator.id]);
    await organizationRepository.removeMember(org.id, creator.id);
    await User.collection.deleteOne({ _id: creator._id });
    const validation = await userApiKeyService.validateUserApiKey(minted.key, {
      db: { userApiKeys: userApiKeyRepository },
    });
    expect(validation.isValid).toBe(true);
    expect(validation.userId).toBe(principal.id);
    await expect(
      assertOrgServiceAccountRequest(principal, validation, { method: 'POST', path: '/api/lattice/chat' })
    ).resolves.toBeUndefined();
    const billingOrg = await organizationRepository.findById(org.id);
    expect(() => assertApiKeyOrgMembership({ billingUser: principal, billingOrg, isApiKeyCaller: true })).not.toThrow();
    expect(resolveRequestBillingOrgId({ user: principal, apiKeyInfo: validation })).toBe(org.id);
    expect(
      attributeToRequestApiKey({} as Parameters<typeof attributeToRequestApiKey>[0], { apiKeyInfo: validation })
    ).toHaveProperty('apiKeyId', minted.id);
    const adapters = {
      users: userRepository,
      organizations: organizationRepository,
      creditTransactions: creditTransactionRepository,
      newAccountSpendCap: {
        adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
        personalSpendSince: async () => [],
      },
    };
    const logger = new Logger({ metadata: { test: 'service-account-billing' } });
    const hold = await creditService.holdCredits(
      {
        userId: principal.id,
        organizationId: org.id,
        requiredCredits: 10,
        featureLabel: 'test compute',
        logger,
        assertBillable: (billingUser, billingOrg) =>
          assertApiKeyOrgMembership({ billingUser, billingOrg, isApiKeyCaller: true }),
      },
      adapters
    );
    await creditService.settleCreditHold(
      hold,
      7,
      {
        type: 'completion_api_usage',
        model: 'test-model',
        source: 'api',
        inputTokens: 1,
        outputTokens: 1,
        apiKeyId: minted.id,
      },
      { featureLabel: 'test compute', logger, throwOnWriteFailure: true },
      adapters
    );
    expect((await Organization.findById(org.id).orFail()).currentCredits).toBe(93);
    expect((await User.findById(principal.id).orFail()).currentCredits).toBe(principal.currentCredits);
    const ledger = await CreditTransaction.findOne({ apiKeyId: minted.id }).orFail();
    expect(ledger.ownerId).toBe(org.id);
    expect(ledger.ownerType).toBe(CreditHolderType.Organization);
    const afterBilling = await Organization.findById(org.id).orFail();
    expect(afterBilling.seats).toBe(3);
    expect(afterBilling.users).toHaveLength(0);
    await expect(resolveServiceKey(creator, org.id, minted.id)).rejects.toThrow();
    const rotated = await userApiKeyService.rotateUserApiKey(
      owner.id,
      { keyId: minted.id },
      {
        serviceAccountManagement: true,
        db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository },
      }
    );
    expect((await UserApiKey.findById(minted.id).orFail()).userId).toBe(principal.id);
    expect(
      (await userApiKeyService.validateUserApiKey(minted.key, { db: { userApiKeys: userApiKeyRepository } })).isValid
    ).toBe(false);
    expect(
      (await userApiKeyService.validateUserApiKey(rotated.key, { db: { userApiKeys: userApiKeyRepository } })).userId
    ).toBe(principal.id);
    await userApiKeyRepository.revokeIfNotDisabled(minted.id, owner.id);
    expect(
      (await userApiKeyService.validateUserApiKey(rotated.key, { db: { userApiKeys: userApiKeyRepository } })).isValid
    ).toBe(false);
    expect(
      await OrganizationAuditEventModel.countDocuments({
        organizationId: org.id,
        action: 'api_key.created',
        targetId: minted.id,
      })
    ).toBe(1);
  });
  it('rejects non-admin minting and cross-org compute grants without creating principals', async () => {
    const actor = await User.create({ name: 'member', username: 'member', email: null });
    const org = await Organization.create({
      name: 'other',
      userId: new mongoose.Types.ObjectId().toString(),
      users: [],
    });
    const input = {
      name: 'denied',
      scopes: [ApiKeyScope.AI_CHAT],
      grants: [{ resourceType: 'organization', resourceId: org.id, permission: 'compute' }],
    };
    await expect(createServiceKey(actor, org.id, input)).rejects.toThrow();
    const ownOrg = await Organization.create({ name: 'own', userId: actor.id });
    await expect(createServiceKey(actor, ownOrg.id, input)).rejects.toThrow('Grant must belong');
    expect(await User.countDocuments({ 'orgServiceAccount.organizationId': ownOrg.id })).toBe(0);
  });
  it('requires a persisted matching org on project grants at mint and every use', async () => {
    const actor = await User.create({ name: 'project owner', username: 'project-owner', email: null });
    const org = await Organization.create({ name: 'projects', userId: actor.id });
    const project = await Project.create({ name: 'explicit', userId: actor.id });
    const input = {
      name: 'reader',
      scopes: [ApiKeyScope.READ_PROJECTS],
      grants: [{ resourceType: 'project', resourceId: project.id, permission: 'read' }],
    };
    await expect(createServiceKey(actor, org.id, input)).rejects.toThrow('Grant must belong');
    await Project.collection.updateOne({ _id: project._id }, { $set: { organizationId: org.id } });
    const minted = await createServiceKey(actor, org.id, input);
    const principal = await User.findById(minted.principalId).orFail();
    const validation = await userApiKeyService.validateUserApiKey(minted.key, {
      db: { userApiKeys: userApiKeyRepository },
    });
    const request = { method: 'GET', path: '/api/v1/projects/[id]', resourceId: project.id };
    await expect(assertOrgServiceAccountRequest(principal, validation, request)).resolves.toBeUndefined();
    await Project.collection.updateOne(
      { _id: project._id },
      { $set: { organizationId: new mongoose.Types.ObjectId().toString() } }
    );
    await expect(assertOrgServiceAccountRequest(principal, validation, request)).rejects.toThrow(
      'resource grant required'
    );
  });
  it('rolls back principal and key creation when the audit write fails', async () => {
    const actor = await User.create({ name: 'audit owner', username: 'audit-owner', email: null });
    const org = await Organization.create({ name: 'audit team', userId: actor.id });
    const audit = vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await expect(
        createServiceKey(actor, org.id, {
          name: 'rollback',
          scopes: [ApiKeyScope.AI_CHAT],
          grants: [{ resourceType: 'organization', resourceId: org.id, permission: 'compute' }],
        })
      ).rejects.toThrow('audit unavailable');
    } finally {
      audit.mockRestore();
    }
    expect(await User.countDocuments({ 'orgServiceAccount.organizationId': org.id })).toBe(0);
    expect(await UserApiKey.countDocuments({ organizationId: org.id })).toBe(0);
  });
});
