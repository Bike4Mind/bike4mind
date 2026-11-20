// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOrganizationDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { OrganizationSharingSettings } from './OrganizationSharingSettings';

const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: requests }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'owner' } }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetOrganizationUsers: () => ({ data: [] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const theme = extendTheme({ ...getThemeConfig() });
const organization = (id = 'org') =>
  ({
    id,
    userId: 'owner',
    users: [],
    name: id,
    sharingPolicy: { allowPublicLinks: true, allowExternalSharing: true, allowedDomains: [] },
  }) as unknown as IOrganizationDocument;
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
function Page({ id }: { id: string }) {
  const { data } = useGetOrganization(id);
  return data ? (
    <>
      <output data-testid="server-policy-kind">{data.sharingPolicy ? 'explicit' : 'default'}</output>
      <OrganizationSharingSettings organization={data} />
    </>
  ) : null;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const element = (id: string) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <Page id={id} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  const view = render(element('org'));
  return { client, switchOrg: (id: string) => view.rerender(element(id)) };
}
beforeEach(() => {
  requests.get.mockReset();
  requests.put.mockReset();
  requests.get.mockImplementation(async (url: string) => ({ data: organization(url.split('/').at(-1)) }));
});
afterEach(() => {
  clients.forEach(client => client.clear());
  clients.length = 0;
});
describe('sharing policy with real organization query and mutation', () => {
  it('preserves a dirty draft across an unchanged server refetch', async () => {
    requests.get.mockResolvedValueOnce({ data: { ...organization(), sharingPolicy: undefined } });
    const { client } = mount();
    await screen.findByTestId('organization-sharing-domains-input');
    fireEvent.change(screen.getByTestId('organization-sharing-domains-input'), { target: { value: 'draft.example' } });
    fireEvent.click(screen.getByTestId('organization-sharing-public-switch'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['organizations', 'org'] });
    });
    await waitFor(() => expect(screen.getByTestId('server-policy-kind')).toHaveTextContent('explicit'));
    expect(screen.getByTestId('organization-sharing-domains-input')).toHaveValue('draft.example');
    expect(screen.getByTestId('organization-sharing-public-switch')).not.toBeChecked();
  });
  it('freezes controls through the PUT and invalidation, then resets for another organization', async () => {
    const save = deferred<{ data: IOrganizationDocument }>();
    const refresh = deferred<{ data: IOrganizationDocument }>();
    requests.put.mockReturnValue(save.promise);
    const { switchOrg } = mount();
    await screen.findByTestId('organization-sharing-domains-input');
    fireEvent.change(screen.getByTestId('organization-sharing-domains-input'), { target: { value: 'saved.example' } });
    fireEvent.click(screen.getByTestId('organization-sharing-save-btn'));
    await waitFor(() => expect(requests.put).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('organization-sharing-domains-input')).toBeDisabled();
    requests.get.mockReturnValueOnce(refresh.promise);
    await act(async () => {
      save.resolve({
        data: {
          ...organization(),
          sharingPolicy: {
            allowPublicLinks: true,
            allowExternalSharing: true,
            allowedDomains: ['saved.example'],
          },
        },
      });
    });
    await waitFor(() => expect(requests.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('organization-sharing-public-switch')).toBeDisabled();
    expect(screen.getByTestId('organization-sharing-domains-input')).toBeDisabled();
    await act(async () => {
      refresh.resolve({ data: organization() });
    });
    await waitFor(() => expect(screen.getByTestId('organization-sharing-domains-input')).not.toBeDisabled());
    expect(screen.getByTestId('organization-sharing-domains-input')).toHaveValue('saved.example');
    switchOrg('another-org');
    await waitFor(() => expect(screen.getByTestId('organization-sharing-domains-input')).toHaveValue(''));
    fireEvent.click(screen.getByTestId('organization-sharing-save-btn'));
    await waitFor(() => expect(requests.put.mock.calls.at(-1)?.[0]).toBe('/api/organizations/another-org'));
  });
});
