import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

// `vi.mock` factories are hoisted above this file's own declarations, so the mock must be
// created by `vi.hoisted` to be in scope when the factory runs.
const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

vi.mock('@client/app/components/TanStackRouterProvider', () => ({
  TanStackRouterProvider: () => null,
}));

import { TanStackRouterProvider } from '@client/app/components/TanStackRouterProvider';
import Page from './page';

const render = (slug?: string[]) => Page({ params: Promise.resolve({ slug }) });

describe('SPA catch-all page', () => {
  beforeEach(() => {
    mocks.notFound.mockClear();
  });

  // Regression: before the fix the page had no asset branch, so a missing asset rendered the
  // HTML shell (200) instead of calling notFound() (404).
  it('calls notFound() for a static-asset path', async () => {
    // Nested so the page cannot pass by testing only the first segment.
    await expect(render(['assets', 'nope.mjs'])).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it('renders the SPA router for a client route', async () => {
    const element = (await render(['some', 'client', 'route'])) as ReactElement;
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(element.type).toBe(TanStackRouterProvider);
  });
});
