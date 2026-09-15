import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType } from '@bike4mind/common';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { delete: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: any) => options,
  useQuery: () => ({}),
  useQueryClient: () => ({}),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@client/app/contexts/ApiContext';
import { useCancelInvite } from '../invites';

/**
 * The cancel URL must carry the raw InviteType, not the lowercase alias the create/list calls
 * use. Static routes such as pages/api/projects/[id]/invites.ts shadow the [type] catch-all at
 * the same path position and register no DELETE, so an aliased path 404s before the handler runs.
 */
describe('useCancelInvite', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [InviteType.Project, '/api/Project/doc-1/invites'],
    [InviteType.Organization, '/api/Organization/doc-1/invites'],
    [InviteType.FabFile, '/api/FabFile/doc-1/invites'],
  ])('sends the raw %s value in the path', async (type: InviteType, expectedUrl: string) => {
    await (useCancelInvite({}) as any).mutationFn({ id: 'doc-1', type, email: 'a@b.test' });

    expect(api.delete).toHaveBeenCalledWith(expectedUrl, { data: { email: 'a@b.test' } });
  });
});
