import { z } from 'zod';
import { ApiKeyScope, CreditHolderType, type IUserDocument } from '@bike4mind/common';
import {
  Project,
  userApiKeyRepository,
  agentRepository,
  userRepository,
  organizationRepository,
} from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/db-core';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import { assertApiKeyAccessAllowed } from '@bike4mind/server-utils/utils/apiKeyAccessGate';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const serviceKeyInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(z.enum([ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS]))
      .min(1)
      .max(2),
    grants: z
      .array(
        z.discriminatedUnion('resourceType', [
          z
            .object({ resourceType: z.literal('organization'), resourceId: objectId, permission: z.literal('compute') })
            .strict(),
          z
            .object({ resourceType: z.literal('project'), resourceId: objectId, permission: z.literal('read') })
            .strict(),
        ])
      )
      .min(1)
      .max(25),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export async function createServiceKey(actor: IUserDocument, organizationId: string, body: unknown) {
  const input = serviceKeyInput.parse(body);
  const org = await verifyOrgAccess(actor, organizationId);
  await assertApiKeyAccessAllowed(actor, { billingOwnerType: CreditHolderType.Organization, organizationId });
  if (input.expiresAt && new Date(input.expiresAt) <= new Date())
    throw new BadRequestError('Expiry must be in the future');
  return withTransaction(async () => {
    for (const grant of input.grants) {
      if (grant.resourceType === 'organization') {
        if (grant.resourceId !== organizationId) throw new BadRequestError('Grant must belong to this organization');
      } else if (
        !(await Project.findOne({ _id: grant.resourceId, organizationId }).setOptions({ strictQuery: false }))
      ) {
        throw new BadRequestError('Grant must belong to this organization');
      }
    }
    const principal = await userApiKeyService.getOrCreateOrgServiceAccount(org, {
      db: { users: userRepository, organizations: organizationRepository },
    });
    const result = await userApiKeyService.createUserApiKey(
      principal.id,
      {
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        organizationId,
        billingOwnerType: CreditHolderType.Organization,
        metadata: { createdFrom: 'dashboard' },
        orgOwned: { createdByUserId: actor.id, grants: input.grants },
      },
      { db: { userApiKeys: userApiKeyRepository, agents: agentRepository } }
    );
    await recordOrganizationAuditEvent({
      organizationId,
      actorUserId: actor.id,
      action: 'api_key.created',
      targetId: result.id,
    });
    return { ...result, principalId: principal.id, grants: input.grants };
  });
}

export async function resolveServiceKey(actor: IUserDocument, organizationId: string, keyId: string) {
  await verifyOrgAccess(actor, organizationId);
  if (!objectId.safeParse(keyId).success) throw new NotFoundError('API key not found');
  const key = await userApiKeyRepository.findByOrganizationIdsAndId([organizationId], keyId);
  if (!key?.orgOwned) throw new NotFoundError('API key not found');
  return key;
}
