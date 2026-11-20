import {
  ApiKeyScope,
  ForbiddenError,
  MethodNotAllowedError,
  hasAdminPermission,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';
import type { Request, Response } from 'express';
import { baseApi } from './baseApi';

type AdminMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
type BaseApiOptions = NonNullable<Parameters<typeof baseApi>[0]>;
type AdminApiOptions = Omit<BaseApiOptions, 'auth' | 'allowedMethods'> & {
  auth?: true | 'jwtOnly';
  /** A list admits any one of its permissions, so a write permission can also open its own page's reads. */
  adminPermissions: Partial<Record<AdminMethod, AdminPermissionRequirement>>;
};
type PermissionRequest = {
  user?: Parameters<typeof hasAdminPermission>[0];
  apiKeyInfo?: { scopes: readonly string[] };
};

export function requireAdminPermission(req: PermissionRequest, requirement: AdminPermissionRequirement): void {
  if (req.apiKeyInfo && !req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN)) {
    throw new ForbiddenError('Insufficient API key permissions', { required_scopes: [ApiKeyScope.ADMIN] });
  }
  if (!meetsAdminPermissionRequirement(req.user, requirement)) {
    throw new ForbiddenError(
      missingAdminPermissionMessage(requirement),
      typeof requirement === 'string' ? { required_permission: requirement } : { required_any_of: requirement }
    );
  }
}

export function adminApi<Req extends Request = Request, Res extends Response = Response>(options: AdminApiOptions) {
  const { adminPermissions, ...baseOptions } = options;
  const methods = Object.keys(adminPermissions);
  if (methods.length === 0) throw new Error('Admin routes must declare at least one permission');
  if (Object.values(adminPermissions).some(requirement => requirement?.length === 0)) {
    throw new Error('Admin route permission lists must not be empty');
  }

  return baseApi<Req, Res>({ ...baseOptions, allowedMethods: methods }).use((req, _res, next) => {
    const method = req.method === 'HEAD' && !adminPermissions.HEAD ? 'GET' : req.method;
    const requirement = adminPermissions[method as AdminMethod];
    if (!requirement) throw new MethodNotAllowedError('Admin route has no permission declared for this method');
    requireAdminPermission(req, requirement);
    next();
  });
}
