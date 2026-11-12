import { ApiKeyScope, CreditHolderType, type IUserDocument, type IUserApiKey } from '@bike4mind/common';
import { organizationRepository, Project } from '@bike4mind/database';
import { ForbiddenError } from '../utils/errors';

type Key = {
  orgOwned?: IUserApiKey['orgOwned'];
  organizationId?: string;
  billingOwnerType?: CreditHolderType;
  scopes?: readonly string[];
};

export function serviceAccountRequestGrant(
  account: Pick<IUserDocument, 'serviceAccountOrganizationId'>,
  key: Key,
  request: { method: string; path: string; resourceId?: unknown }
): { resourceType: 'project' | 'organization'; resourceId: string; permission: 'read' | 'compute' } | null {
  if (
    !key.orgOwned ||
    key.billingOwnerType !== CreditHolderType.Organization ||
    !account.serviceAccountOrganizationId ||
    key.organizationId !== account.serviceAccountOrganizationId
  )
    return null;

  const grant =
    request.method === 'POST' && request.path === '/api/lattice/chat'
      ? {
          resourceType: 'organization' as const,
          resourceId: account.serviceAccountOrganizationId,
          permission: 'compute' as const,
        }
      : request.method === 'GET' && request.path === '/api/v1/projects/[id]' && typeof request.resourceId === 'string'
        ? { resourceType: 'project' as const, resourceId: request.resourceId, permission: 'read' as const }
        : null;
  if (!grant) return null;
  const scope = grant.permission === 'compute' ? ApiKeyScope.AI_CHAT : ApiKeyScope.READ_PROJECTS;
  if (!key.scopes?.includes(scope)) return null;
  return key.orgOwned.grants?.some(
    candidate =>
      candidate.resourceType === grant.resourceType &&
      candidate.resourceId === grant.resourceId &&
      candidate.permission === grant.permission
  )
    ? grant
    : null;
}

export async function assertOrgServiceAccountRequest(
  user: Pick<IUserDocument, 'isSystem' | 'isAdmin' | 'serviceAccountOrganizationId'>,
  key: Key,
  request: { method: string; path: string; resourceId?: unknown }
): Promise<void> {
  if (!user.serviceAccountOrganizationId && !key.orgOwned) return;
  if (!user.isSystem || user.isAdmin || !serviceAccountRequestGrant(user, key, request)) {
    throw new ForbiddenError('Service account resource grant required');
  }
  if (!(await organizationRepository.findById(user.serviceAccountOrganizationId!))) {
    throw new ForbiddenError('Service account organization unavailable');
  }
  if (request.path === '/api/v1/projects/[id]') {
    const project = await Project.findOne({
      _id: request.resourceId,
      organizationId: user.serviceAccountOrganizationId,
    }).setOptions({ strictQuery: false });
    if (!project) throw new ForbiddenError('Service account resource grant required');
  }
}
