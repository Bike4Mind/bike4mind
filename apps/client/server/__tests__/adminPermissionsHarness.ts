import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';

export type AdminPermissionsState = { guard: unknown; options: unknown };

export type AdminPermissionCase = {
  file: string;
  method: string;
  permission: string;
  /** Every method the route declares in its adminApi permission map; defaults to [method]. */
  allowedMethods?: string[];
  /** A permission the route must refuse; defaults to one other than `permission`, which an any-of route may accept. */
  rejectedPermission?: string;
};

export const createAdminPermissionsState = (): AdminPermissionsState => ({ guard: undefined, options: undefined });

/** Factory for the `@server/middlewares/baseApi` mock: captures the options and the first `.use` guard. */
export const baseApiMock = (state: AdminPermissionsState) => ({
  baseApi: (options: unknown) => {
    state.options = options;
    const chain: Record<string, unknown> = {};
    for (const m of ['get', 'post', 'patch', 'delete', 'put']) chain[m] = () => chain;
    chain.use = (fn: unknown) => {
      if (!state.guard) state.guard = fn;
      return chain;
    };
    return chain;
  },
});

/** `importRoute` must do the dynamic import from the calling test file so relative case paths resolve there. */
export function describeAdminPermissionCases(
  cases: AdminPermissionCase[],
  state: AdminPermissionsState,
  importRoute: (file: string) => Promise<unknown>
) {
  const runGuard = (method: string, user: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const next = vi.fn();
    (state.guard as (req: Request, res: Response, next: () => void) => void)(
      { method, user, ...extra } as unknown as Request,
      {} as Response,
      next
    );
    return next;
  };

  const capturedByFile = new Map<string, AdminPermissionsState>();

  describe.each(cases)(
    '$file ($method, $permission)',
    ({ file, method, permission, allowedMethods, rejectedPermission }) => {
      // The guard checks are pure, so one import per route serves every case on it. Resetting the
      // module graph is the fallback only: it re-evaluates the route's whole dependency tree, and a
      // route that has not been imported yet registers its guard without it.
      beforeAll(async () => {
        const captured = capturedByFile.get(file);
        if (captured) {
          Object.assign(state, captured);
          return;
        }
        state.guard = undefined;
        state.options = undefined;
        await importRoute(file);
        if (!state.guard) {
          vi.resetModules();
          await importRoute(file);
        }
        capturedByFile.set(file, { guard: state.guard, options: state.options });
      });

      it('allows a delegate holding the declared permission without isAdmin', () => {
        expect(runGuard(method, { isAdmin: false, adminPermissions: [permission] })).toHaveBeenCalledOnce();
      });

      it('rejects a delegate holding a different permission', () => {
        const other = rejectedPermission ?? (permission === 'support:read' ? 'settings:manage' : 'support:read');
        expect(() => runGuard(method, { isAdmin: false, adminPermissions: [other] })).toThrow(
          new RegExp(`^Missing permission: (.+ or )?${permission}( or .+)?$`)
        );
      });

      it('rejects a non-admin with no permissions', () => {
        expect(() => runGuard(method, { isAdmin: false })).toThrow();
      });

      it('allows a full admin', () => {
        expect(runGuard(method, { isAdmin: true })).toHaveBeenCalledOnce();
      });

      it('rejects a full admin using an API key without the admin scope', () => {
        expect(() => runGuard(method, { isAdmin: true }, { apiKeyInfo: { scopes: ['chat:read'] } })).toThrow(
          'Insufficient API key permissions'
        );
      });

      it('allows a full admin using an admin-scoped API key', () => {
        expect(
          runGuard(method, { isAdmin: true }, { apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] } })
        ).toHaveBeenCalledOnce();
      });

      it('declares exactly the expected allowed methods', () => {
        const actual = (state.options as { allowedMethods: string[] }).allowedMethods;
        expect([...actual].sort()).toEqual([...(allowedMethods ?? [method])].sort());
      });
    }
  );
}
