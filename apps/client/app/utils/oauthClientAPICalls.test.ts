import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

import {
  addOAuthClientRole,
  assignUserOAuthClientRole,
  createOAuthClient,
  fetchOAuthClientRoles,
  fetchOAuthClients,
  fetchUserOAuthClientRoles,
  removeOAuthClientRole,
  rotateOAuthClientSecret,
  unassignUserOAuthClientRole,
  updateOAuthClient,
} from './oauthClientAPICalls';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({ data: 'payload' });
});

describe('oauthClientAPICalls', () => {
  it('calls the client endpoints and unwraps the data', async () => {
    await expect(fetchOAuthClients()).resolves.toBe('payload');
    expect(api.get).toHaveBeenCalledWith('/api/admin/oauth-clients');
    await expect(createOAuthClient({ name: 'A', redirectUris: [] })).resolves.toBe('payload');
    expect(api.post).toHaveBeenCalledWith('/api/admin/oauth-clients', { name: 'A', redirectUris: [] });
    await expect(updateOAuthClient('c1', { isActive: false })).resolves.toBe('payload');
    expect(api.patch).toHaveBeenCalledWith('/api/admin/oauth-clients/c1', { isActive: false });
    await expect(rotateOAuthClientSecret('c1')).resolves.toBe('payload');
    expect(api.post).toHaveBeenCalledWith('/api/admin/oauth-clients/c1/rotate-secret');
  });

  it('calls the client role endpoints', async () => {
    await expect(fetchOAuthClientRoles('c1')).resolves.toBe('payload');
    expect(api.get).toHaveBeenCalledWith('/api/admin/oauth-clients/c1/roles');
    const role = { key: 'admin', label: 'Admin', reason: 'Because' };
    await expect(addOAuthClientRole('c1', role)).resolves.toBe('payload');
    expect(api.post).toHaveBeenCalledWith('/api/admin/oauth-clients/c1/roles', role);
    await expect(removeOAuthClientRole('c1', 'a/b', 'Because')).resolves.toBe('payload');
    expect(api.delete).toHaveBeenCalledWith('/api/admin/oauth-clients/c1/roles/a%2Fb', { data: { reason: 'Because' } });
  });

  it('calls the user role endpoints', async () => {
    await expect(fetchUserOAuthClientRoles('u1')).resolves.toBe('payload');
    expect(api.get).toHaveBeenCalledWith('/api/admin/users/u1/oauth-client-roles');
    const data = { clientId: 'b4m_x', role: 'admin', reason: 'Because' };
    await expect(assignUserOAuthClientRole('u1', data)).resolves.toBeUndefined();
    expect(api.post).toHaveBeenCalledWith('/api/admin/users/u1/oauth-client-roles', data);
    await expect(unassignUserOAuthClientRole('u1', data)).resolves.toBeUndefined();
    expect(api.delete).toHaveBeenCalledWith('/api/admin/users/u1/oauth-client-roles', { data });
  });
});
