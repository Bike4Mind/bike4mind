import {
  ApiKeyScope,
  ForbiddenError,
  MethodNotAllowedError,
  hasAdminPermission,
  missingAdminPermissionMessage,
  type AdminPermissionId,
} from '@bike4mind/common';
import type { Request, Response } from 'express';
import { baseApi } from './baseApi';

type AdminMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
type BaseApiOptions = NonNullable<Parameters<typeof baseApi>[0]>;
type AdminApiOptions = Omit<BaseApiOptions, 'auth' | 'allowedMethods'> & {
  auth?: true | 'jwtOnly';
  adminPermissions: Partial<Record<AdminMethod, AdminPermissionId>>;
};
type PermissionRequest = {
  user?: Parameters<typeof hasAdminPermission>[0];
  apiKeyInfo?: { scopes: readonly string[] };
};

export function requireAdminPermission(req: PermissionRequest, permission: AdminPermissionId): void {
  if (req.apiKeyInfo && !req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN)) {
    throw new ForbiddenError('Insufficient API key permissions', { required_scopes: [ApiKeyScope.ADMIN] });
  }
  if (!hasAdminPermission(req.user, permission)) {
    throw new ForbiddenError(missingAdminPermissionMessage(permission), { required_permission: permission });
  }
}

export function adminApi<Req extends Request = Request, Res extends Response = Response>(options: AdminApiOptions) {
  const { adminPermissions, ...baseOptions } = options;
  const methods = Object.keys(adminPermissions);
  if (methods.length === 0) throw new Error('Admin routes must declare at least one permission');

  return baseApi<Req, Res>({ ...baseOptions, allowedMethods: methods }).use((req, _res, next) => {
    const method = req.method === 'HEAD' && !adminPermissions.HEAD ? 'GET' : req.method;
    const permission = adminPermissions[method as AdminMethod];
    if (!permission) throw new MethodNotAllowedError('Admin route has no permission declared for this method');
    requireAdminPermission(req, permission);
    next();
  });
}
