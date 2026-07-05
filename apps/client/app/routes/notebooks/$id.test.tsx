import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// Mocks
const mockNavigate = vi.fn();
let paramsValue: Record<string, unknown> = { id: 'sess-1' };

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => paramsValue,
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

// Heavy children are irrelevant to the redirect logic under test - stub them.
vi.mock('@client/app/components/Session/NotebookFilepondProvider', () => ({
  NotebookFilepondProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@client/app/components/Session/SessionContainer', () => ({
  default: () => <div data-testid="session-container-stub" />,
}));

// useGetSession is the unit under test's input - control its result per test.
let sessionQuery: Record<string, unknown> = {};
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetSession: () => sessionQuery,
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({
  useDocumentTitle: () => undefined,
}));
vi.mock('@client/app/hooks/useUnreadProactiveMessages', () => ({
  useMarkSessionViewed: () => undefined,
}));

let pendingOptimisticId: string | null = null;
vi.mock('@client/app/hooks/useSessionLayout', () => ({
  default: (selector: (s: { pendingOptimisticId: string | null }) => unknown) => selector({ pendingOptimisticId }),
}));

vi.mock('@client/app/utils/llm', () => ({
  isOptimisticId: (id: string) => id.startsWith('optimistic-'),
}));

import NotebookPage from './$id';

const notFoundError = { isAxiosError: true, response: { status: 404 } };

beforeEach(() => {
  mockNavigate.mockClear();
  toastError.mockClear();
  paramsValue = { id: 'sess-1' };
  pendingOptimisticId = null;
  sessionQuery = {};
});

describe('NotebookPage not-found handling', () => {
  it('redirects to /new and toasts when the session 404s (inaccessible or missing)', () => {
    sessionQuery = { isLoading: false, isError: true, data: undefined, error: notFoundError };

    render(<NotebookPage />);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/new' });
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('does not redirect while the session is still loading', () => {
    sessionQuery = { isLoading: true, isError: false, data: undefined, error: null };

    render(<NotebookPage />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not redirect when the session loads successfully', () => {
    sessionQuery = { isLoading: false, isError: false, data: { id: 'sess-1', name: 'My notebook' }, error: null };

    render(<NotebookPage />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does not redirect during an optimistic→real session transition', () => {
    paramsValue = { id: 'optimistic-123' };
    sessionQuery = { isLoading: false, isError: false, data: undefined, error: null };

    render(<NotebookPage />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects to /new when the session resolves empty (200 with no data)', () => {
    sessionQuery = { isLoading: false, isError: false, data: undefined, error: null };

    render(<NotebookPage />);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/new' });
    // No error toast for a plain empty result - only the not-found path toasts.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('fires the not-found toast and redirect at most once (StrictMode-safe)', () => {
    // StrictMode double-invokes effects in dev; the hasRedirectedRef guard must
    // keep the toast/navigate to a single occurrence.
    sessionQuery = { isLoading: false, isError: true, data: undefined, error: notFoundError };

    render(
      <React.StrictMode>
        <NotebookPage />
      </React.StrictMode>
    );

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire the redirect when the query result is a new reference with unchanged values', () => {
    sessionQuery = { isLoading: false, isError: true, data: undefined, error: notFoundError };

    const { rerender } = render(<NotebookPage />);
    // Simulate React Query handing back a fresh result object with identical values.
    sessionQuery = { isLoading: false, isError: true, data: undefined, error: { ...notFoundError } };
    rerender(<NotebookPage />);

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });
});
