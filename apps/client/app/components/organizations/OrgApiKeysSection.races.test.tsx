import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ApiKeyScope, ApiKeyStatus, type IOrgApiKeyView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: transport }));
vi.mock('sonner', () => ({ toast: notices }));
// Deliberately do not mock orgApiKeys hooks, QueryClient, scope/request hook, access fields, or Joy modals.
import OrgApiKeysSection from './OrgApiKeysSection';

type Action = 'create' | 'rotate' | 'callback';
type HttpResponse = { data: unknown };
const theme = extendTheme({ ...getThemeConfig() });
let client: QueryClient;

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const keyFor = (organizationId: string): IOrgApiKeyView => ({
  id: 'key1',
  name: `${organizationId} service`,
  keyPrefix: 'b4m_live_fixture',
  scopes: [ApiKeyScope.AI_GENERATE],
  grants: [],
  status: ApiKeyStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});
const responseFor = (action: Action, token: string): HttpResponse => ({
  data:
    action === 'callback'
      ? {
          id: 'key1',
          name: 'Webhook service',
          callbackSigningSecret: token,
          callbackSigningSecretCreatedAt: '2026-01-02T00:00:00Z',
        }
      : { apiKey: keyFor('orgA'), key: token },
});
const expectedUrl = (action: Action, organizationId = 'orgA'): string => {
  const base = `/api/organizations/${organizationId}/api-keys`;
  return action === 'create' ? base : `${base}/key1/${action === 'callback' ? 'callback-secret' : 'rotate'}`;
};
const view = (organizationId: string) => (
  <QueryClientProvider client={client}>
    <CssVarsProvider theme={theme}>
      <OrgApiKeysSection organizationId={organizationId} />
    </CssVarsProvider>
  </QueryClientProvider>
);
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // Do NOT set default gcTime:0: this test must exercise the production secret-mutation policy.
  transport.get.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/options')) return { data: { scopes: [ApiKeyScope.AI_GENERATE], groups: [] } };
    const match = /^\/api\/organizations\/([^/]+)\/api-keys$/.exec(url);
    if (!match) throw new Error(`Unexpected GET ${url}`);
    return { data: [keyFor(match[1])] };
  });
  transport.post.mockReset();
  transport.patch.mockReset();
  transport.delete.mockReset();
  notices.success.mockReset();
  notices.error.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

async function openAction(action: Action): Promise<{ dialog: HTMLElement; submit: HTMLElement }> {
  await screen.findByTestId('org-api-key-row-key1');
  if (action === 'create') {
    fireEvent.click(screen.getByTestId('org-api-key-new-btn'));
    const dialog = screen.getByTestId('org-api-key-create-modal');
    fireEvent.change(within(dialog).getByTestId('org-api-key-name-input'), { target: { value: 'Pending key' } });
    fireEvent.click(await within(dialog).findByTestId(`org-api-key-scope-${ApiKeyScope.AI_GENERATE}`));
    const submit = within(dialog).getByTestId('org-api-key-create-submit-btn');
    expect(submit).not.toBeDisabled();
    return { dialog, submit };
  }
  fireEvent.click(screen.getByTestId(`org-api-key-${action === 'callback' ? 'callback-secret' : 'rotate'}-btn-key1`));
  const dialog = screen.getByTestId('confirmation-dialog');
  return { dialog, submit: within(dialog).getByTestId('confirmation-confirm-btn') };
}
function clickBackdrop(dialog: HTMLElement): void {
  const backdrop = dialog.closest('.MuiModal-root')?.querySelector('.MuiModal-backdrop');
  if (!(backdrop instanceof HTMLElement)) throw new Error('Real Joy backdrop missing');
  fireEvent.click(backdrop);
}
async function noCachedSecret(token: string): Promise<void> {
  await waitFor(() =>
    expect(
      client
        .getMutationCache()
        .getAll()
        .some(mutation => (JSON.stringify(mutation.state.data) ?? '').includes(token))
    ).toBe(false)
  );
}

// Each action exercises the actual production hooks and their own request owner.
describe.each(['create', 'rotate', 'callback'] as const)('org secret %s request ownership', action => {
  it('blocks same-tick duplicate submission before React can disable the button', async () => {
    const response = deferred<HttpResponse>();
    transport.post.mockReturnValue(response.promise);
    render(view('orgA'));
    try {
      const { submit } = await openAction(action);
      act(() => {
        fireEvent.click(submit);
        expect(submit.isConnected).toBe(true);
        expect(submit).not.toBeDisabled(); // proves this second click is not blocked by a committed render
        fireEvent.click(submit);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      expect(transport.post.mock.calls[0][0]).toBe(expectedUrl(action));
      expect(client.isMutating()).toBe(1);
      await act(async () => {
        response.resolve(responseFor(action, 'secret-once'));
      });
      await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('secret-once'));
      await noCachedSecret('secret-once');
    } finally {
      await act(async () => {
        response.resolve(responseFor(action, 'secret-once'));
      });
    }
  });

  it('refuses Escape/backdrop dismissal while pending and keeps create inputs frozen', async () => {
    const response = deferred<HttpResponse>();
    transport.post.mockReturnValue(response.promise);
    render(view('orgA'));
    try {
      const { dialog, submit } = await openAction(action);
      fireEvent.click(submit);
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(dialog.isConnected).toBe(true);
      clickBackdrop(dialog);
      expect(dialog.isConnected).toBe(true);
      if (action === 'create') {
        expect(within(dialog).getByTestId('org-api-key-name-input')).toBeDisabled();
        expect(within(dialog).getByTestId(`org-api-key-scope-${ApiKeyScope.AI_GENERATE}`)).toBeDisabled();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        expect(dialog.isConnected).toBe(true);
      }
      expect(transport.post).toHaveBeenCalledTimes(1);
      await act(async () => {
        response.resolve(responseFor(action, 'secret-after-wait'));
      });
      await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('secret-after-wait'));
      await noCachedSecret('secret-after-wait');
    } finally {
      await act(async () => {
        response.resolve(responseFor(action, 'secret-after-wait'));
      });
    }
  });

  it('returns to retryable idle after failure instead of losing the dialog or draft', async () => {
    const response = deferred<HttpResponse>();
    transport.post.mockReturnValueOnce(response.promise);
    render(view('orgA'));
    try {
      const { dialog, submit } = await openAction(action);
      fireEvent.click(submit);
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      await act(async () => {
        response.reject(new Error('Server failed'));
      });
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(dialog.isConnected).toBe(true);
      expect(submit).not.toBeDisabled();
      if (action === 'create') expect(within(dialog).getByTestId('org-api-key-name-input')).toHaveValue('Pending key');
      expect(screen.queryByTestId('org-api-key-secret-value')).toBeNull();
      transport.post.mockResolvedValueOnce(responseFor(action, 'retried-secret'));
      fireEvent.click(submit);
      await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('retried-secret'));
      expect(transport.post).toHaveBeenCalledTimes(2);
      await noCachedSecret('retried-secret');
    } finally {
      response.resolve(responseFor(action, 'unused-cleanup'));
    }
  });

  it('rejects an old A completion after A→B→A without closing or resetting the new A request', async () => {
    const oldResponse = deferred<HttpResponse>();
    const newResponse = deferred<HttpResponse>();
    transport.post.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const rendered = render(view('orgA'));
    try {
      const first = await openAction(action);
      fireEvent.click(first.submit);
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      rendered.rerender(view('orgB'));
      expect(screen.queryByTestId('org-api-key-create-modal')).toBeNull();
      expect(screen.queryByTestId('confirmation-dialog')).toBeNull();
      expect(screen.queryByTestId('org-api-key-secret-value')).toBeNull();
      rendered.rerender(view('orgA'));
      const current = await openAction(action);
      fireEvent.click(current.submit);
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
      expect(client.isMutating()).toBe(2);
      await act(async () => {
        oldResponse.resolve(responseFor(action, 'old-A-plaintext'));
      });
      await waitFor(() => expect(client.isMutating()).toBe(1));
      expect(current.dialog.isConnected).toBe(true);
      expect(screen.queryByTestId('org-api-key-secret-value')).toBeNull();
      await noCachedSecret('old-A-plaintext');
      await act(async () => {
        newResponse.resolve(responseFor(action, 'new-A-plaintext'));
      });
      await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('new-A-plaintext'));
      await noCachedSecret('new-A-plaintext');
    } finally {
      await act(async () => {
        oldResponse.resolve(responseFor(action, 'old-A-plaintext'));
        newResponse.resolve(responseFor(action, 'new-A-plaintext'));
      });
    }
  });

  it('ignores an old A failure after A→B→A while the new request remains pending', async () => {
    const oldResponse = deferred<HttpResponse>();
    const newResponse = deferred<HttpResponse>();
    transport.post.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const rendered = render(view('orgA'));
    try {
      const first = await openAction(action);
      fireEvent.click(first.submit);
      await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      rendered.rerender(view('orgB'));
      rendered.rerender(view('orgA'));
      const current = await openAction(action);
      fireEvent.click(current.submit);
      await waitFor(() => expect(client.isMutating()).toBe(2));
      await act(async () => {
        oldResponse.reject(new Error('Old scope failed'));
      });
      await waitFor(() => expect(client.isMutating()).toBe(1));
      await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(1));
      expect(current.dialog.isConnected).toBe(true);
      expect(current.submit).toBeDisabled();
      expect(screen.queryByTestId('org-api-key-secret-value')).toBeNull();
      await act(async () => {
        newResponse.resolve(responseFor(action, 'new-after-old-failure'));
      });
      await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('new-after-old-failure'));
      await noCachedSecret('new-after-old-failure');
    } finally {
      await act(async () => {
        oldResponse.resolve(responseFor(action, 'old-cleanup'));
        newResponse.resolve(responseFor(action, 'new-after-old-failure'));
      });
    }
  });
});

describe.each([
  ['create', 'API key', 'API key copied'],
  ['callback', 'callback signing secret', 'Callback signing secret copied'],
] as const)('%s copy wording', (action, label, successMessage) => {
  it.each(['success', 'failure'] as const)(
    'uses kind-specific %s copy text and the exact clipboard bytes',
    async outcome => {
      transport.post.mockResolvedValue(responseFor(action, 'clipboard-only-secret'));
      const writeText =
        outcome === 'success'
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new Error('Clipboard refused'));
      const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        render(<OrgApiKeysSection organizationId="orgA" />, { wrapper: Wrapper });
        const { submit } = await openAction(action);
        fireEvent.click(submit);
        await screen.findByTestId('org-api-key-secret-value');
        fireEvent.click(screen.getByTestId('org-api-key-copy-btn'));
        await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('clipboard-only-secret'));
        if (outcome === 'success') await waitFor(() => expect(notices.success).toHaveBeenCalledWith(successMessage));
        else
          await waitFor(() =>
            expect(notices.error).toHaveBeenCalledWith(`Could not copy; select the ${label} and copy it manually`)
          );
        await noCachedSecret('clipboard-only-secret');
      } finally {
        if (original) Object.defineProperty(navigator, 'clipboard', original);
        else Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  );
});
