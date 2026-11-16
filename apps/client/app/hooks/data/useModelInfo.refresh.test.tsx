// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { ModelCatalog } from '@client/app/utils/llm';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useSelectedAccount } from '@client/app/components/Credits/selectedAccountStore';
import { ORG_CATALOG_REFETCH_MS, ORG_CATALOG_STALE_MS, useModelInfo } from './useModelInfo';

const llm = vi.hoisted(() => ({ getModelCatalog: vi.fn() }));
vi.mock('@client/app/utils/llm', () => llm);

const catalog = (id: string): ModelCatalog => ({
  models: [{ id, name: id, type: 'text', backend: ModelBackend.OpenAI } as ModelInfo],
  lockedModels: [],
  supersededModels: [],
  modelListRevision: null,
  catalogUnavailable: false,
});

function Picker() {
  const { data } = useModelInfo();
  return <div data-testid="model-picker-first-model">{data?.[0]?.id}</div>;
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

async function mountWith(account: { id: string; personal: boolean }) {
  useSelectedAccount.setState({ selectedAccount: { ...account, name: account.id, credits: 10 } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <QueryClientProvider client={client}>
      <Picker />
    </QueryClientProvider>
  );
  await flush();
  return client;
}

async function refocus() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await flush();
}

const shown = () => screen.getByTestId('model-picker-first-model').textContent;

describe('model catalog refresh without a live organizations event', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    useAccessToken.setState({ accessToken: 'test-session', mfaPending: false });
    llm.getModelCatalog.mockReset();
    llm.getModelCatalog.mockResolvedValueOnce(catalog('before')).mockResolvedValue(catalog('after'));
  });
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('refetches an org catalog when the tab regains focus after the stale window', async () => {
    await mountWith({ id: 'org-a', personal: false });
    expect(shown()).toBe('before');

    await act(() => vi.advanceTimersByTimeAsync(ORG_CATALOG_STALE_MS + 1));
    await refocus();

    expect(llm.getModelCatalog).toHaveBeenCalledTimes(2);
    expect(llm.getModelCatalog).toHaveBeenLastCalledWith('org-a');
    expect(shown()).toBe('after');
  });

  it('does not refetch an org catalog on focus inside the stale window', async () => {
    await mountWith({ id: 'org-a', personal: false });
    await refocus();

    expect(llm.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(shown()).toBe('before');
  });

  it('refreshes a focused org tab on the slow interval', async () => {
    await mountWith({ id: 'org-a', personal: false });
    expect(shown()).toBe('before');

    await act(() => vi.advanceTimersByTimeAsync(ORG_CATALOG_REFETCH_MS));
    await flush();

    expect(llm.getModelCatalog).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(shown()).toBe('after'));
  });

  it('leaves the personal catalog on its long stale time with no focus refetch or interval', async () => {
    await mountWith({ id: 'user-1', personal: true });

    await act(() => vi.advanceTimersByTimeAsync(ORG_CATALOG_REFETCH_MS + 1));
    await refocus();

    expect(llm.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(llm.getModelCatalog).toHaveBeenCalledWith(null);
    expect(shown()).toBe('before');
  });
});
