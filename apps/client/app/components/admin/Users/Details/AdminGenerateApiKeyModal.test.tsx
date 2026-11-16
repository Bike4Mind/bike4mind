import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import {
  EXPLICIT_ONLY_API_KEY_SCOPES,
  GENERIC_MODAL_API_KEY_SCOPES,
  genericApiKeyScopesFor,
} from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { useUser } from '@client/app/contexts/UserContext';
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
  bypass: false,
}));

vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => h.hasOptiAccess }));
vi.mock('@client/app/hooks/data/productScopeAccess', () => ({
  useOverwatchAccess: () => true,
  useHearthEnabled: () => true,
  useApiKeyScopeEntitlements: () => ({ bypass: h.bypass, entitlements: new Set<string>() }),
}));

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
  useAdminGenerateApiKey: () => ({ mutateAsync: h.mutate, isPending: false }),
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
  useUser.setState({ currentUser: { id: 'admin1', isAdmin: true } as never });
  h.lakes = [
    { id: 'lakeA', name: 'Lake A', canPreauthorize: true },
    { id: 'lakeB', name: 'Lake B', canPreauthorize: true },
  ];
  h.lakesLoading = false;
  h.lakesError = false;
  h.askedForUserId = undefined;
  h.hasOptiAccess = true;
  h.bypass = false;
  h.refetchLakes.mockClear();
  h.mutate.mockClear();
  h.mutate.mockResolvedValue({ key: 'secret' });
});

const confirmGeneration = async () => {
  fireEvent.click(screen.getByText('Generate API Key'));
  expect(h.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-reason-input-preset-0'));
  await act(async () => fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-confirm-btn')));
};

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

  it('submits with no preauthorizedLakeIds when none are checked', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await confirmGeneration();

    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toBeUndefined();
  });

  it('checking a lake includes its id, and unchecking removes it, in the submitted data', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeB').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('2 selected');

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');
    await confirmGeneration();
    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toEqual(['lakeB']);
  });
});

describe('AdminGenerateApiKeyModal - ingest scopes', () => {
  const GENERIC = GENERIC_MODAL_API_KEY_SCOPES[0].value;
  const scopeInput = (value: string) => screen.getByTestId(`admin-generate-key-scope-${value}`).querySelector('input')!;

  const submitScopes = async () => {
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'ci ingest' } });
    await confirmGeneration();
    return h.mutate.mock.calls[0][0].data.scopes;
  };

  it('offers QA ingest but not Overwatch ingest, which needs a productId this path never sends', () => {
    renderModal();
    expect(screen.getByText('QA: Ingest')).toBeTruthy();
    expect(screen.queryByTestId(`admin-generate-key-scope-${ApiKeyScope.OVERWATCH_INGEST_WRITE}`)).toBeNull();
  });

  it('the generic counter ignores a selected ingest scope, and Select All replaces it', () => {
    renderModal();
    const offeredScopes = genericApiKeyScopesFor({
      hasOptiAccess: true,
      hasOverwatchAccess: true,
      hearthEnabled: true,
      bypass: false,
      entitlements: new Set<string>(),
    });
    const offered = offeredScopes.length;
    const bulk = offeredScopes.filter(s => !EXPLICIT_ONLY_API_KEY_SCOPES.has(s.value)).length;
    const counter = () => screen.getByTestId('admin-generate-key-scopes-count').textContent;
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    expect(counter()).toContain(`(0/${offered} selected)`);

    fireEvent.click(screen.getByText('Select All'));
    expect(counter()).toContain(`(${bulk}/${offered} selected)`);
    expect(scopeInput(ApiKeyScope.QA_INGEST).checked).toBe(false);
    // A key that can mint keys is only ever granted by ticking it.
    expect(scopeInput(ApiKeyScope.API_KEYS_MANAGE).checked).toBe(false);

    fireEvent.click(screen.getByText('Clear All'));
    expect(counter()).toContain(`(0/${offered} selected)`);
    expect(scopeInput(ApiKeyScope.QA_INGEST).checked).toBe(false);
  });

  it('an ingest scope replaces the selection, since it must be the only scope', async () => {
    renderModal();
    fireEvent.click(scopeInput(GENERIC));
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    expect(await submitScopes()).toEqual([ApiKeyScope.QA_INGEST]);
  });

  it('a generic scope drops a selected ingest scope', async () => {
    renderModal();
    fireEvent.click(scopeInput(ApiKeyScope.QA_INGEST));
    fireEvent.click(scopeInput(GENERIC));
    expect(await submitScopes()).toEqual([GENERIC]);
  });
});

describe('AdminGenerateApiKeyModal - ingest scopes for a delegate', () => {
  it('disables the ingest scopes with the reason for a delegate, but not the generic ones', () => {
    useUser.setState({
      currentUser: { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke', 'users:impersonate'] } as never,
    });
    renderModal();
    const input = (value: string) => screen.getByTestId(`admin-generate-key-scope-${value}`).querySelector('input')!;
    expect(input(ApiKeyScope.QA_INGEST)).toBeDisabled();
    expect(screen.getByTestId('admin-generate-key-ingest-reason')).toHaveTextContent(/Only full administrators/);
    expect(input(GENERIC_MODAL_API_KEY_SCOPES[0].value)).toBeEnabled();
  });

  it('leaves the ingest scopes selectable for a full admin', () => {
    renderModal();
    expect(
      screen.getByTestId(`admin-generate-key-scope-${ApiKeyScope.QA_INGEST}`).querySelector('input')
    ).toBeEnabled();
    expect(screen.queryByTestId('admin-generate-key-ingest-reason')).toBeNull();
  });
});

describe('AdminGenerateApiKeyModal - write permissions', () => {
  it('disables minting without keys:revoke or users:impersonate', () => {
    useUser.setState({ currentUser: { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke'] } as never });
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'new key' } });
    fireEvent.click(
      screen.getByTestId(`admin-generate-key-scope-${GENERIC_MODAL_API_KEY_SCOPES[0].value}`).querySelector('input')!
    );
    expect(screen.getByText('Generate API Key').closest('button')).toBeDisabled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('disables minting for a protected admin target even with both delegate permissions', () => {
    useUser.setState({
      currentUser: { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke', 'users:impersonate'] } as never,
    });
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminGenerateApiKeyModal open onClose={vi.fn()} user={{ ...USER, isAdmin: true }} />
      </CssVarsProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'new key' } });
    fireEvent.click(
      screen.getByTestId(`admin-generate-key-scope-${GENERIC_MODAL_API_KEY_SCOPES[0].value}`).querySelector('input')!
    );
    expect(screen.getByText('Generate API Key').closest('button')).toBeDisabled();
    expect(h.mutate).not.toHaveBeenCalled();
  });
});

describe('AdminGenerateApiKeyModal - reason for admin-provisioned scopes', () => {
  const scopeInput = (value: string) => screen.getByTestId(`admin-generate-key-scope-${value}`).querySelector('input')!;
  const submitButton = () => screen.getByTestId('admin-generate-key-action-dialog-confirm-btn');
  const nameKey = () =>
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'rewards key' } });

  it('requires an audited reason for self-service scopes too', async () => {
    renderModal();
    nameKey();
    fireEvent.click(scopeInput(GENERIC_MODAL_API_KEY_SCOPES[0].value));
    fireEvent.click(screen.getByText('Generate API Key'));
    expect(submitButton()).toBeDisabled();
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-reason-input-preset-0'));
    await act(async () => fireEvent.click(submitButton()));
    expect(h.mutate.mock.calls[0][0].data.reason).toBe('Partner integration');
  });

  it('requires a reason before an admin-provisioned scope can be minted', () => {
    renderModal();
    nameKey();
    fireEvent.click(scopeInput(ApiKeyScope.REWARDS_GRANT));

    fireEvent.click(screen.getByText('Generate API Key'));
    expect(submitButton()).toBeDisabled();

    fireEvent.change(screen.getByTestId('admin-generate-key-action-dialog-reason-input'), { target: { value: 'abc' } });
    expect(submitButton()).toBeDisabled();
  });

  it('submits the composed reason with the key', async () => {
    renderModal();
    nameKey();
    fireEvent.click(scopeInput(ApiKeyScope.REWARDS_GRANT));
    fireEvent.click(screen.getByText('Generate API Key'));
    fireEvent.click(screen.getByTestId('admin-generate-key-action-dialog-reason-input-preset-0'));
    fireEvent.change(screen.getByTestId('admin-generate-key-action-dialog-reason-input'), {
      target: { value: 'game server' },
    });

    expect(submitButton()).not.toBeDisabled();
    await act(async () => fireEvent.click(submitButton()));
    expect(h.mutate.mock.calls[0][0].data).toMatchObject({
      scopes: [ApiKeyScope.REWARDS_GRANT],
      reason: 'Partner integration: game server',
    });
  });

  it('keeps the confirmation open when generation fails', async () => {
    h.mutate.mockRejectedValue(new Error('generation failed'));
    renderModal();
    nameKey();
    fireEvent.click(scopeInput(GENERIC_MODAL_API_KEY_SCOPES[0].value));
    await confirmGeneration();
    expect(screen.getByTestId('admin-generate-key-action-dialog')).toBeTruthy();
    expect(screen.queryByText('Copy this key now. It will not be shown again.')).toBeNull();
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
    const offeredScopes = genericApiKeyScopesFor({
      hasOptiAccess: false,
      hasOverwatchAccess: true,
      hearthEnabled: true,
      bypass: false,
      entitlements: new Set(),
    });
    const bulk = offeredScopes.filter(s => !EXPLICIT_ONLY_API_KEY_SCOPES.has(s.value)).length;
    expect(screen.getByTestId('admin-generate-key-scopes-count').textContent).toContain(
      `(${bulk}/${offeredScopes.length} selected)`
    );
  });

  it.each([false, true])('offers persona mint only with caller bypass=%s', bypass => {
    h.bypass = bypass;
    renderModal();
    if (bypass) expect(scopeRow(ApiKeyScope.PERSONAS_MINT)).not.toBeNull();
    else expect(scopeRow(ApiKeyScope.PERSONAS_MINT)).toBeNull();
  });

  it('offers the premium scopes with Opti access', () => {
    renderModal();
    for (const scope of PREMIUM) expect(scopeRow(scope)).not.toBeNull();
  });
});
