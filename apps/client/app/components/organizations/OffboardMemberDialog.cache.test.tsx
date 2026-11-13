import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import OffboardMemberDialog from './OffboardMemberDialog';

const requests = vi.hoisted(() => ({
  get: vi.fn<(url: string, options?: { signal?: AbortSignal }) => Promise<{ data: unknown }>>(),
  delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: requests }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
};

const appTheme = extendTheme({ ...getThemeConfig() });
const member = { id: 'member', name: 'New Member' };
const withoutMember = { id: 'org1', userId: 'owner', users: [], userDetails: [] };
const withMember = { ...withoutMember, users: [{ userId: member.id, permissions: [] }] };
const inventory = {
  files: { count: 0, sample: [] },
  artifacts: { count: 0, sample: [] },
  projects: { count: 0, sample: [] },
  notebooks: { count: 0, sample: [] },
  agents: { count: 0, sample: [] },
  orgBilledApiKeys: { count: 0 },
};

// Keep the real roster and offboarding queries mounted across removal and re-addition.
const Members = () => {
  const { data: members = [] } = useGetOrganizationUsers('org1');
  const [selectedMember, setSelectedMember] = useState<{ id: string; name: string } | null>(null);
  return (
    <>
      {members.map(row => (
        <button key={row.id} onClick={() => setSelectedMember({ id: row.id, name: row.name })}>
          Remove {row.name}
        </button>
      ))}
      <OffboardMemberDialog organizationId="org1" member={selectedMember} onClose={() => setSelectedMember(null)} />
    </>
  );
};

describe('offboarding with a fresh roster and cached organization details', () => {
  it('refreshes new and re-added membership while suppressing reads after removal and late refreshes', async () => {
    requests.get.mockReset();
    requests.delete.mockReset();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(['organizations', 'org1'], withoutMember);
    queryClient.setQueryData(['users', 'organization', 'org1'], [member]);
    let serverOrganization = withMember;
    let serverMembers = [member];
    let pendingDetail: ReturnType<typeof deferred<{ data: unknown }>> | undefined = deferred();
    const firstDetail = pendingDetail;
    let pendingSignal: AbortSignal | undefined;
    const inventoryUrl = '/api/organizations/org1/members/member/offboarding';
    requests.get.mockImplementation(async (url, options) => {
      if (url === '/api/organizations/org1') {
        if (pendingDetail) {
          pendingSignal = options?.signal;
          return pendingDetail.promise;
        }
        return { data: serverOrganization };
      }
      if (url === '/api/organizations/org1/members') return { data: serverMembers };
      if (url === inventoryUrl) return { data: inventory };
      throw new Error(`Unexpected request: ${url}`);
    });
    requests.delete.mockImplementation(async () => {
      serverOrganization = withoutMember;
      serverMembers = [];
      return { data: withoutMember };
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
      </QueryClientProvider>
    );
    const view = render(<Members />, { wrapper });
    const inventoryReads = () => requests.get.mock.calls.filter(([url]) => url === inventoryUrl).length;
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove New Member' }));
      await waitFor(() => expect(requests.get).toHaveBeenCalledWith('/api/organizations/org1', expect.anything()));
      expect(screen.getByTestId('offboard-dialog-loading')).toBeTruthy();
      expect(screen.getByTestId('offboard-dialog-confirm-btn')).toBeDisabled();
      expect(inventoryReads()).toBe(0);
      await act(async () => {
        pendingDetail = undefined;
        firstDetail.resolve({ data: withMember });
      });
      await waitFor(() => expect(screen.getByTestId('offboard-dialog-confirm-btn')).toBeEnabled());
      expect(inventoryReads()).toBe(1);

      pendingSignal = undefined;
      pendingDetail = deferred();
      const lateDetail = pendingDetail;
      await act(async () => {
        void queryClient.refetchQueries({ queryKey: ['organizations', 'org1'], exact: true });
      });
      await waitFor(() => expect(pendingSignal).toBeDefined());
      fireEvent.click(screen.getByTestId('offboard-dialog-confirm-btn'));
      await waitFor(() => expect(screen.queryByTestId('offboard-dialog')).toBeNull());
      expect(pendingSignal?.aborted).toBe(true);
      await act(async () => {
        pendingDetail = undefined;
        lateDetail.resolve({ data: withMember });
      });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove New Member' })).toBeNull());
      expect(queryClient.getQueryData(['organizations', 'org1'])).toEqual(withoutMember);
      expect(inventoryReads()).toBe(1);

      serverOrganization = withMember;
      serverMembers = [member];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['users', 'organization', 'org1'], exact: true });
      });
      expect(queryClient.getQueryData(['organizations', 'org1'])).toEqual(withoutMember);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove New Member' }));
      await waitFor(() => expect(screen.getByTestId('offboard-dialog-confirm-btn')).toBeEnabled());
      expect(inventoryReads()).toBe(2);
      expect(queryClient.getQueryData(['organizations', 'org1'])).toEqual(withMember);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
