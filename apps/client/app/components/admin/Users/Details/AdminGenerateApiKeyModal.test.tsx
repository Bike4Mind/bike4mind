import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import { GENERIC_MODAL_API_KEY_SCOPES, genericApiKeyScopesFor } from '@client/app/constants/apiKeyScopes';
import AdminGenerateApiKeyModal from './AdminGenerateApiKeyModal';

const h = vi.hoisted(() => ({
  lakes: [
    { id: 'lakeA', name: 'Lake A', canPreauthorize: true },
    { id: 'lakeB', name: 'Lake B', canPreauthorize: true },
  ] as { id: string; name: string; canPreauthorize: boolean }[] | undefined,
  lakesLoading: false,
  lakesError: false,
  refetchLakes: vi.fn(),
  mutate: vi.fn(),
  // Records who the list was scoped to, so a regression back to the caller-scoped hook is caught
  // here rather than as a 400 at mint time (#2945).
  askedForUserId: undefined as string | undefined,
  hasOptiAccess: true,
}));

vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => h.hasOptiAccess }));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetPreauthorizableDataLakes: (userId: string) => {
    h.askedForUserId = userId;
    return {
      data: h.lakes,
      isLoading: h.lakesLoading,
      isError: h.lakesError,
      refetch: h.refetchLakes,
    };
  },
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGenerateApiKey: () => ({ mutate: h.mutate, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const USER = { id: 'u1', username: 'target-user' } as never;

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminGenerateApiKeyModal open onClose={vi.fn()} user={USER} />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.lakes = [
    { id: 'lakeA', name: 'Lake A', canPreauthorize: true },
    { id: 'lakeB', name: 'Lake B', canPreauthorize: true },
  ];
  h.lakesLoading = false;
  h.lakesError = false;
  h.askedForUserId = undefined;
  h.hasOptiAccess = true;
  h.refetchLakes.mockClear();
  h.mutate.mockClear();
});

describe('AdminGenerateApiKeyModal - pre-authorized lakes', () => {
  it('shows a loading state while lakes are fetching', () => {
    h.lakesLoading = true;
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lakes-loading')).toBeTruthy();
  });

  it('shows an error state with a retry when the lake fetch fails', () => {
    h.lakesError = true;
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lakes-error')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(h.refetchLakes).toHaveBeenCalled();
  });

  it('scopes the lake list to the TARGET user, not the signed-in admin', () => {
    renderModal();
    expect(h.askedForUserId).toBe('u1');
  });

  it('omits a lake the target cannot pre-authorize, which the mint route would 400', () => {
    // A platform admin has canManage on every lake but a rung on almost none, so this is the
    // ordinary case for an admin minting a key for someone else - not an edge case.
    h.lakes = [
      { id: 'lakeA', name: 'Lake A', canPreauthorize: true },
      { id: 'lakeB', name: 'Lake B', canPreauthorize: false },
    ];
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA')).toBeTruthy();
    expect(screen.queryByTestId('admin-generate-key-lake-checkbox-lakeB')).toBeNull();
  });

  it('shows the empty state when the target manages nothing bindable, even if lakes exist', () => {
    h.lakes = [{ id: 'lakeA', name: 'Lake A', canPreauthorize: false }];
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lakes-empty')).toBeTruthy();
    expect(screen.queryByTestId('admin-generate-key-lake-checkbox-lakeA')).toBeNull();
  });

  it('shows an empty state when there are no lakes', () => {
    h.lakes = [];
    renderModal();
    // Names the target, so an admin can tell "this user manages nothing" from "the list failed".
    expect(screen.getByTestId('admin-generate-key-lakes-empty').textContent).toContain('target-user');
  });

  it('submits with no preauthorizedLakeIds when none are checked', () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByText('Generate API Key'));

    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toBeUndefined();
  });

  it('checking a lake includes its id, and unchecking removes it, in the submitted data', () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeB').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('2 selected');

    fireEvent.click(screen.getByText('Generate API Key'));
    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toEqual(['lakeA', 'lakeB']);

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');
  });
});

describe('AdminGenerateApiKeyModal - ingest scopes', () => {
  const GENERIC = GENERIC_MODAL_API_KEY_SCOPES[0].value;
  const scopeInput = (value: string) => screen.getByTestId(`admin-generate-key-scope-${value}`).querySelector('input')!;

  const submitScopes = () => {
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'ci ingest' } });
    fireEvent.click(screen.getByText('Generate API Key'));
    return h.mutate.mock.calls[0][0].data.scopes;
  };

  it('offers QA ingest but not Overwatch ingest, which needs a productId this path never sends', () => {
    renderModal();
    expect(screen.getByText('QA: Ingest')).toBeTruthy();
    expect(screen.queryByTestId(`admin-generate-key-scope-${ApiKeyScope.OVERWATCH_INGEST_WRITE}`)).toBeNull();
  });

  it('the generic counter ignores a selected ingest scope, and Select All replaces it', () => {
    renderModal();
    const counter = () => screen.getByTestId('admin-generate-key-scopes-count').textContent;
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    expect(counter()).toContain(`(0/${GENERIC_MODAL_API_KEY_SCOPES.length} selected)`);

    fireEvent.click(screen.getByText('Select All'));
    expect(counter()).toContain(
      `(${GENERIC_MODAL_API_KEY_SCOPES.length}/${GENERIC_MODAL_API_KEY_SCOPES.length} selected)`
    );
    expect(scopeInput(ApiKeyScope.QA_INGEST).checked).toBe(false);

    fireEvent.click(screen.getByText('Clear All'));
    expect(counter()).toContain(`(0/${GENERIC_MODAL_API_KEY_SCOPES.length} selected)`);
    expect(scopeInput(ApiKeyScope.QA_INGEST).checked).toBe(false);
  });

  it('an ingest scope replaces the selection, since it must be the only scope', () => {
    renderModal();
    fireEvent.click(scopeInput(GENERIC));
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    expect(submitScopes()).toEqual([ApiKeyScope.QA_INGEST]);
  });

  it('a generic scope drops a selected ingest scope', () => {
    renderModal();
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    fireEvent.click(scopeInput(GENERIC));
    expect(submitScopes()).toEqual([GENERIC]);
  });
});

describe('AdminGenerateApiKeyModal - premium scopes', () => {
  const PREMIUM = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
  const scopeRow = (value: string) => screen.queryByTestId(`admin-generate-key-scope-${value}`);

  it('hides the premium scopes, and keeps Select All from granting them, without Opti access', () => {
    h.hasOptiAccess = false;
    renderModal();
    for (const scope of PREMIUM) expect(scopeRow(scope)).toBeNull();

    fireEvent.click(screen.getByText('Select All'));
    const offered = genericApiKeyScopesFor(false).length;
    expect(screen.getByTestId('admin-generate-key-scopes-count').textContent).toContain(
      `(${offered}/${offered} selected)`
    );
  });

  it('offers the premium scopes with Opti access', () => {
    renderModal();
    for (const scope of PREMIUM) expect(scopeRow(scope)).not.toBeNull();
  });
});
