import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dynamic: vi.fn((_loader: () => Promise<unknown>, _options: { ssr: boolean }) => () => null),
}));

vi.mock('next/dynamic', () => ({ default: mocks.dynamic }));
vi.mock('./SpaApp', () => ({ default: () => null }));

import './SpaShell';

describe('SpaShell', () => {
  // ssr: false is what keeps the providers and router out of the server function bundle.
  it('loads the SPA client-only', async () => {
    expect(mocks.dynamic).toHaveBeenCalledTimes(1);
    const [loader, options] = mocks.dynamic.mock.calls[0];
    expect(options).toEqual({ ssr: false });
    const spaApp = await import('./SpaApp');
    expect(await loader()).toBe(spaApp);
  });
});
