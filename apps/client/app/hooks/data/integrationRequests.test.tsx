import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  integrationRequestKeys,
  useToggleIntegrationRequest,
  type IntegrationRequestSummary,
} from './integrationRequests';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), delete: vi.fn(), get: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const post = vi.mocked(api.post);
const del = vi.mocked(api.delete);

/** A request the test settles by hand, to hold a toggle in flight. */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const SEED: IntegrationRequestSummary = { counts: { hubspot: 4, gmail: 2 }, mine: ['gmail'] };

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(integrationRequestKeys.all, SEED);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({ hubspot: useToggleIntegrationRequest('hubspot'), gmail: useToggleIntegrationRequest('gmail') }),
    { wrapper }
  );
  const summary = () => queryClient.getQueryData<IntegrationRequestSummary>(integrationRequestKeys.all);
  return { result, summary, invalidate };
};

describe('useToggleIntegrationRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flips the button and the count at once, then settles on one refetch', async () => {
    const inFlight = deferred();
    post.mockReturnValue(inFlight.promise as never);
    const { result, summary, invalidate } = setup();

    act(() => result.current.hubspot.toggle({ requested: false }));

    await waitFor(() => expect(summary()).toEqual({ counts: { hubspot: 5, gmail: 2 }, mine: ['gmail', 'hubspot'] }));
    expect(result.current.hubspot.isPending).toBe(true);
    expect(result.current.gmail.isPending).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => inFlight.resolve());
    await waitFor(() => expect(result.current.hubspot.isPending).toBe(false));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: integrationRequestKeys.all });
  });

  it('runs a double-click one request at a time, in click order, and refetches once at the end', async () => {
    const first = deferred();
    post.mockReturnValue(first.promise as never);
    del.mockResolvedValue({ data: undefined });
    const { result, summary, invalidate } = setup();

    act(() => {
      result.current.hubspot.toggle({ requested: false });
      result.current.hubspot.toggle({ requested: true });
    });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // The second click is queued behind the first, not racing it.
    expect(del).not.toHaveBeenCalled();
    expect(summary()).toEqual({ counts: { hubspot: 4, gmail: 2 }, mine: ['gmail'] });

    await act(async () => first.resolve());
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith('/api/integrations/requests', { params: { integrationId: 'hubspot' } });
    await waitFor(() => expect(result.current.hubspot.isPending).toBe(false));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(summary()).toEqual({ counts: { hubspot: 4, gmail: 2 }, mine: ['gmail'] });
  });

  it('does not queue toggles of different entries behind each other', async () => {
    const hubspot = deferred();
    post.mockReturnValue(hubspot.promise as never);
    del.mockResolvedValue({ data: undefined });
    const { result, invalidate } = setup();

    act(() => {
      result.current.hubspot.toggle({ requested: false });
      result.current.gmail.toggle({ requested: true });
    });

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.gmail.isPending).toBe(false));
    // gmail settled while hubspot is still in flight: no refetch that would undo hubspot's optimistic state.
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => hubspot.resolve());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it('rolls a failed toggle back, tells the user, and still refetches', async () => {
    post.mockRejectedValue(new Error('boom'));
    const { result, summary, invalidate } = setup();

    act(() => result.current.hubspot.toggle({ requested: false }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't send your request. Try again."));
    expect(summary()).toEqual({ counts: { hubspot: 4, gmail: 2 }, mine: ['gmail'] });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it('words a failed withdraw as a withdraw', async () => {
    del.mockRejectedValue(new Error('boom'));
    const { result, summary } = setup();

    act(() => result.current.gmail.toggle({ requested: true }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't withdraw your request. Try again."));
    expect(summary()).toEqual({ counts: { hubspot: 4, gmail: 2 }, mine: ['gmail'] });
  });

  it("undoes only its own change, leaving another entry's optimistic update alone", async () => {
    const gmail = deferred();
    del.mockReturnValue(gmail.promise as never);
    const hubspot = deferred();
    post.mockReturnValue(hubspot.promise as never);
    const { result, summary } = setup();

    act(() => {
      result.current.gmail.toggle({ requested: true });
      result.current.hubspot.toggle({ requested: false });
    });
    await waitFor(() => expect(summary()).toEqual({ counts: { hubspot: 5, gmail: 1 }, mine: ['hubspot'] }));

    await act(async () => hubspot.reject(new Error('boom')));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // hubspot is back to the server's number; gmail's withdraw, still in flight, is untouched.
    expect(summary()).toEqual({ counts: { hubspot: 4, gmail: 1 }, mine: [] });

    await act(async () => gmail.resolve());
  });
});
