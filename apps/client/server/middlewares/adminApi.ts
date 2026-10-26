import {
  ApiKeyScope,
  ForbiddenError,
  MethodNotAllowedError,
  hasAdminPermission,
  type AdminPermissionId,
} from '@bike4mind/common';
import type { Request, Response } from 'express';
import { baseApi } from './baseApi';
import { persistedIsAdmin } from '@server/auth/apiKeyAdminScope';

type AdminMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
type BaseApiOptions = NonNullable<Parameters<typeof baseApi>[0]>;
type AdminApiOptions = Omit<BaseApiOptions, 'auth' | 'allowedMethods'> & {
  auth?: true | 'jwtOnly';
  adminPermissions: Partial<Record<AdminMethod, AdminPermissionId>>;
  alternateApiKeyPermission?: {
    scope: typeof ApiKeyScope.RELEASE_NOTES_WRITE;
    permission: 'support:read' | 'settings:manage';
  };
  organizationOwnerRead?: true;
};
type PermissionRequest = {
  user?: Parameters<typeof hasAdminPermission>[0];
  apiKeyInfo?: { scopes: readonly string[] };
};

export function requireAdminPermission(
  req: PermissionRequest,
  permission: AdminPermissionId,
  alternate?: AdminApiOptions['alternateApiKeyPermission']
): void {
  if (req.apiKeyInfo && !req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN)) {
    if (
      alternate?.permission === permission &&
      alternate.scope === ApiKeyScope.RELEASE_NOTES_WRITE &&
      req.apiKeyInfo.scopes.includes(alternate.scope) &&
      req.user &&
      persistedIsAdmin(req.user)
    )
      return;
    throw new ForbiddenError('Insufficient API key permissions', { required_scopes: [ApiKeyScope.ADMIN] });
  }
  if (!hasAdminPermission(req.user, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`, { required_permission: permission });
  }
}

export function adminApi<Req extends Request = Request, Res extends Response = Response>(options: AdminApiOptions) {
  const { adminPermissions, alternateApiKeyPermission, organizationOwnerRead, ...baseOptions } = options;
  const methods = Object.keys(adminPermissions);
  if (methods.length === 0) throw new Error('Admin routes must declare at least one permission');

  return baseApi<Req, Res>({ ...baseOptions, allowedMethods: methods }).use((req, _res, next) => {
    const method = req.method === 'HEAD' && !adminPermissions.HEAD ? 'GET' : req.method;
    const permission = adminPermissions[method as AdminMethod];
    if (!permission) throw new MethodNotAllowedError('Admin route has no permission declared for this method');
    if (
      organizationOwnerRead &&
      permission === 'support:read' &&
      (method === 'GET' || method === 'HEAD') &&
      !req.apiKeyInfo &&
      !hasAdminPermission(req.user, permission)
    ) {
      return authorizeOrganizationOwnerRead(req, next);
    }
    requireAdminPermission(req, permission, alternateApiKeyPermission);
    next();
  });
}

async function authorizeOrganizationOwnerRead(req: Request, next: () => void): Promise<void> {
  const { verifyOrgUsageRead } = await import('@server/utils/adminUsageRead');
  if (!req.user || typeof req.query.organizationId !== 'string') {
    throw new ForbiddenError('Missing permission: support:read');
  }
  await verifyOrgUsageRead(req.user, req.query.organizationId);
  next();
}
