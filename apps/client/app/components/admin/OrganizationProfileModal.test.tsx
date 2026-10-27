import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

const { useGetOrganizationMock, toastErrorMock } = vi.hoisted(() => ({
  useGetOrganizationMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({ useGetOrganization: useGetOrganizationMock }));
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }));
vi.mock('./OrganizationProfileUpdated', () => ({
  default: ({ org, onClose }: { org: { name: string }; onClose: () => void }) => (
    <button data-testid="org-profile-close-btn" onClick={onClose}>
      {org.name}
    </button>
  ),
}));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import OrganizationProfileModal from './OrganizationProfileModal';

const ORG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = (onClosed = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationProfileModal onClosed={onClosed} />
    </CssVarsProvider>
  );
  return onClosed;
};

const httpError = (status: number) =>
  new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

beforeEach(() => {
  useGetOrganizationMock.mockReset();
  toastErrorMock.mockReset();
  act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 2 }));
});

describe('OrganizationProfileModal', () => {
  it('renders nothing while no organization is open', () => {
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: false, error: null });
    renderModal();

    expect(useGetOrganizationMock).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('admin-organization-profile-modal')).toBeNull();
  });

  it('fetches the organization named by orgId and closes by removing it from the URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 2, orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: { id: ORG_ID, name: 'Acme' }, isFetching: false, error: null });
    const onClosed = renderModal();

    expect(useGetOrganizationMock).toHaveBeenCalledWith(ORG_ID);
    fireEvent.click(screen.getByTestId('org-profile-close-btn'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 2 });
    expect(onClosed).toHaveBeenCalled();
  });

  it('shows a loader until the organization arrives', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: true, error: null });
    renderModal();

    expect(screen.getByTestId('admin-organization-profile-loading')).toBeTruthy();
  });

  it('closes on a settled 404 and says so', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 2, orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: false, error: httpError(404) });
    renderModal();

    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 2 });
    expect(toastErrorMock).toHaveBeenCalledWith('That organization could not be found.', expect.anything());
  });

  it('stays open on a 404 that is still refetching', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: true, error: httpError(404) });
    renderModal();

    expect(fakeAdminRouter.search).toMatchObject({ orgId: ORG_ID });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('stays open and says so when the load fails with a server error', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: false, error: httpError(500) });
    renderModal();

    expect(fakeAdminRouter.search).toMatchObject({ orgId: ORG_ID });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-organization-profile-error')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('This organization could not be loaded.');
  });

  it('shows the load error, not cached data, when a reopened organization fails to refetch', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({
      data: { id: ORG_ID, name: 'Acme' },
      isFetching: false,
      error: httpError(500),
      refetch: vi.fn(),
    });
    renderModal();

    expect(screen.getByTestId('admin-organization-profile-error')).toBeTruthy();
    expect(screen.getByTestId('admin-organization-profile-retry-btn')).toBeTruthy();
    expect(screen.queryByTestId('org-profile-close-btn')).toBeNull();
  });

  it('retries the load from the error state', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    const refetch = vi.fn();
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: false, error: httpError(500), refetch });
    renderModal();

    fireEvent.click(screen.getByTestId('admin-organization-profile-retry-btn'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  // OrganizationProfileUpdated resets unsaved edits when `org` changes, so a refetch must not reach it.
  it('keeps showing the organization as opened when the query refetches new data', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: { id: ORG_ID, name: 'Acme' }, isFetching: false, error: null });
    const { rerender } = render(
      <CssVarsProvider theme={appTheme}>
        <OrganizationProfileModal onClosed={vi.fn()} />
      </CssVarsProvider>
    );

    useGetOrganizationMock.mockReturnValue({
      data: { id: ORG_ID, name: 'Acme Renamed' },
      isFetching: false,
      error: null,
    });
    rerender(
      <CssVarsProvider theme={appTheme}>
        <OrganizationProfileModal onClosed={vi.fn()} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('org-profile-close-btn').textContent).toBe('Acme');
  });

  it('shows fresh data when the organization is closed and opened again', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: { id: ORG_ID, name: 'Acme' }, isFetching: false, error: null });
    renderModal();

    fireEvent.click(screen.getByTestId('org-profile-close-btn'));
    useGetOrganizationMock.mockReturnValue({
      data: { id: ORG_ID, name: 'Acme Renamed' },
      isFetching: false,
      error: null,
    });
    act(() => fakeAdminRouter.navigate({ to: '/admin', search: previous => ({ ...previous, orgId: ORG_ID }) }));

    expect(screen.getByTestId('org-profile-close-btn').textContent).toBe('Acme Renamed');
  });

  it('shows a loader, not cached data, while a reopened organization refetches', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: { id: ORG_ID, name: 'Acme' }, isFetching: true, error: null });
    const { rerender } = render(
      <CssVarsProvider theme={appTheme}>
        <OrganizationProfileModal onClosed={vi.fn()} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('admin-organization-profile-loading')).toBeTruthy();
    expect(screen.queryByTestId('org-profile-close-btn')).toBeNull();

    useGetOrganizationMock.mockReturnValue({
      data: { id: ORG_ID, name: 'Acme Renamed' },
      isFetching: false,
      error: null,
    });
    rerender(
      <CssVarsProvider theme={appTheme}>
        <OrganizationProfileModal onClosed={vi.fn()} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('org-profile-close-btn').textContent).toBe('Acme Renamed');
  });
});
