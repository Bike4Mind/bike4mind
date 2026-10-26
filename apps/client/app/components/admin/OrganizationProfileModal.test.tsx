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

const notFound = () =>
  new AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
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
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: false, error: notFound() });
    renderModal();

    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 2 });
    expect(toastErrorMock).toHaveBeenCalledWith('That organization could not be found.', expect.anything());
  });

  it('stays open on a 404 that is still refetching', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: ORG_ID }));
    useGetOrganizationMock.mockReturnValue({ data: undefined, isFetching: true, error: notFound() });
    renderModal();

    expect(fakeAdminRouter.search).toMatchObject({ orgId: ORG_ID });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
