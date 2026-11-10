import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PAGE_QUERY_KEY, PAGES_LIST_QUERY_KEY, type ICustomPageDocument } from '@bike4mind/common';
import {
  useCreateCustomPage,
  useCustomPage,
  useCustomPages,
  useDeleteCustomPage,
  useRemovePageWidget,
  useToggleChecklistItem,
  useUpdateCustomPage,
} from '../customPages';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: mocks }));

const PAGE_ID = 'a'.repeat(24);

const makePage = (checked = false): ICustomPageDocument => ({
  id: PAGE_ID,
  userId: 'u1',
  name: 'Daily menu',
  state: {},
  widgets: [{ id: 'shopping-list', type: 'checklist', items: [{ id: 'eggs', label: 'Eggs', checked }] }],
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const checkedOf = (page: ICustomPageDocument | undefined) => {
  const widget = page?.widgets[0];
  return widget?.type === 'checklist' ? widget.items[0].checked : undefined;
};

const setup = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  return { cache, wrapper };
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('custom page hooks', () => {
  it('lists pages and fetches one page under the shared query keys', async () => {
    const { cache, wrapper } = setup();
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/pages' ? { data: { pages: [{ id: PAGE_ID }] } } : { data: { page: makePage() } })
    );
    const list = renderHook(() => useCustomPages(), { wrapper });
    const one = renderHook(() => useCustomPage(PAGE_ID), { wrapper });
    await waitFor(() => expect(list.result.current.data).toEqual([{ id: PAGE_ID }]));
    await waitFor(() => expect(one.result.current.data?.name).toBe('Daily menu'));
    expect(mocks.get).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}`);
    expect(cache.getQueryData(PAGES_LIST_QUERY_KEY)).toBeDefined();
    expect(cache.getQueryData(PAGE_QUERY_KEY(PAGE_ID))).toBeDefined();
  });

  it('does not fetch a page without an id', () => {
    const { wrapper } = setup();
    renderHook(() => useCustomPage(undefined), { wrapper });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('creates, updates and deletes pages and refreshes the list', async () => {
    const { cache, wrapper } = setup();
    cache.setQueryData(PAGES_LIST_QUERY_KEY, []);
    mocks.post.mockResolvedValue({ data: { page: makePage() } });
    mocks.patch.mockResolvedValue({ data: { page: { ...makePage(), name: 'Renamed' } } });
    mocks.delete.mockResolvedValue({});
    const create = renderHook(() => useCreateCustomPage(), { wrapper });
    const update = renderHook(() => useUpdateCustomPage(), { wrapper });
    const remove = renderHook(() => useDeleteCustomPage(), { wrapper });

    await act(async () => {
      await create.result.current.mutateAsync({ name: 'Daily menu' });
    });
    expect(mocks.post).toHaveBeenCalledWith('/api/pages', { name: 'Daily menu' });
    expect(cache.getQueryState(PAGES_LIST_QUERY_KEY)?.isInvalidated).toBe(true);

    await act(async () => {
      await update.result.current.mutateAsync({ id: PAGE_ID, name: 'Renamed' });
    });
    expect(mocks.patch).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}`, { name: 'Renamed' });
    expect(cache.getQueryData<ICustomPageDocument>(PAGE_QUERY_KEY(PAGE_ID))?.name).toBe('Renamed');

    await act(async () => {
      await remove.result.current.mutateAsync(PAGE_ID);
    });
    expect(mocks.delete).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}`);
    expect(cache.getQueryData(PAGE_QUERY_KEY(PAGE_ID))).toBeUndefined();
  });

  it('toggles a checklist item optimistically', async () => {
    const { cache, wrapper } = setup();
    cache.setQueryData(PAGE_QUERY_KEY(PAGE_ID), makePage(false));
    let resolve: (value: unknown) => void = () => undefined;
    mocks.patch.mockReturnValue(new Promise(r => (resolve = r)));
    const toggle = renderHook(() => useToggleChecklistItem(PAGE_ID), { wrapper });

    act(() => toggle.result.current.mutate({ widgetId: 'shopping-list', itemId: 'eggs', checked: true }));
    await waitFor(() => expect(checkedOf(cache.getQueryData(PAGE_QUERY_KEY(PAGE_ID)))).toBe(true));
    expect(mocks.patch).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}/widgets/shopping-list/items/eggs`, {
      checked: true,
    });

    await act(async () => {
      resolve({ data: { page: makePage(true) } });
    });
    await waitFor(() => expect(toggle.result.current.isSuccess).toBe(true));
    expect(checkedOf(cache.getQueryData(PAGE_QUERY_KEY(PAGE_ID)))).toBe(true);
  });

  it('rolls back the optimistic toggle when the request fails', async () => {
    const { cache, wrapper } = setup();
    cache.setQueryData(PAGE_QUERY_KEY(PAGE_ID), makePage(false));
    mocks.patch.mockRejectedValue(new Error('boom'));
    const toggle = renderHook(() => useToggleChecklistItem(PAGE_ID), { wrapper });

    act(() => toggle.result.current.mutate({ widgetId: 'shopping-list', itemId: 'eggs', checked: true }));
    await waitFor(() => expect(toggle.result.current.isError).toBe(true));
    expect(checkedOf(cache.getQueryData(PAGE_QUERY_KEY(PAGE_ID)))).toBe(false);
  });

  it('removes a widget and stores the returned page', async () => {
    const { cache, wrapper } = setup();
    mocks.delete.mockResolvedValue({ data: { page: { ...makePage(), widgets: [] } } });
    const remove = renderHook(() => useRemovePageWidget(PAGE_ID), { wrapper });
    await act(async () => {
      await remove.result.current.mutateAsync('shopping-list');
    });
    expect(mocks.delete).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}/widgets/shopping-list`);
    expect(cache.getQueryData<ICustomPageDocument>(PAGE_QUERY_KEY(PAGE_ID))?.widgets).toEqual([]);
  });
});
