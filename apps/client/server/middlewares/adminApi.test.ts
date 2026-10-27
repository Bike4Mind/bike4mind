import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, ADMIN_PERMISSIONS, type AdminPermissionId } from '@bike4mind/common';
import type { Request, Response } from 'express';

const { state } = vi.hoisted(() => ({ state: { middleware: undefined as unknown, options: undefined as unknown } }));
vi.mock('./baseApi', () => ({
  baseApi: (options: unknown) => {
    state.options = options;
    const chain = {
      use: (middleware: unknown) => {
        state.middleware = middleware;
        return chain;
      },
    };
    return chain;
  },
}));
import { adminApi, requireAdminPermission } from './adminApi';

const runGuard = (method: string, permissions: AdminPermissionId[], isAdmin = false) => {
  const next = vi.fn();
  const middleware = state.middleware as (req: Request, res: Response, next: () => void) => void;
  middleware({ method, user: { isAdmin, adminPermissions: permissions } } as Request, {} as Response, next);
  return next;
};

beforeEach(() => {
  state.middleware = undefined;
  state.options = undefined;
});

describe('adminApi', () => {
  it.each(ADMIN_PERMISSIONS)('enforces the declared %s permission before the endpoint executes', permission => {
    adminApi({ adminPermissions: { POST: permission } });
    expect(() => runGuard('POST', permission === 'support:read' ? [] : ['support:read'])).toThrow(
      `Missing permission: ${permission}`
    );
    expect(runGuard('POST', [permission])).toHaveBeenCalledOnce();
  });

  it('permits support reads and existing full admins', () => {
    adminApi({ adminPermissions: { GET: 'support:read', POST: 'settings:manage' } });
    expect(runGuard('GET', ['support:read'])).toHaveBeenCalledOnce();
    expect(runGuard('POST', [], true)).toHaveBeenCalledOnce();
    expect(state.options).toMatchObject({ allowedMethods: ['GET', 'POST'] });
  });

  it('maps implicit HEAD to GET while refusing undeclared methods', () => {
    adminApi({ adminPermissions: { GET: 'support:read' } });
    expect(runGuard('HEAD', ['support:read'])).toHaveBeenCalledOnce();
    expect(() => runGuard('PATCH', [], true)).toThrow('no permission declared');
  });

  it('rejects routes with no permission declarations', () => {
    expect(() => adminApi({ adminPermissions: {} })).toThrow('must declare');
  });

  it('keeps API key scopes independent of the owner permissions', () => {
    expect(() =>
      requireAdminPermission({ user: { isAdmin: true }, apiKeyInfo: { scopes: [] } }, 'settings:manage')
    ).toThrow('API key permissions');
    expect(() =>
      requireAdminPermission(
        { user: { adminPermissions: ['credits:adjust'] }, apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] } },
        'credits:adjust'
      )
    ).not.toThrow();
    expect(() =>
      requireAdminPermission(
        { user: { adminPermissions: ['support:read'] }, apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] } },
        'credits:adjust'
      )
    ).toThrow('Missing permission: credits:adjust');
  });

  it('refuses a request with no user', () => {
    expect(() => requireAdminPermission({}, 'support:read')).toThrow('Missing permission: support:read');
  });
});
