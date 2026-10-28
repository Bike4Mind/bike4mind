import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ impersonating: false, query: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: h.query, useMutation: vi.fn(), useQueryClient: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (state: { impersonating: boolean }) => unknown) => select(h),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
import { useMcpServer, useMcpServers } from './mcpServers';
import { useAudioProviders } from './audioProviders';

describe('support access background queries', () => {
  beforeEach(() => h.query.mockClear());
  it.each([true, false])('suppresses credential queries only while impersonating: %s', impersonating => {
    h.impersonating = impersonating;
    renderHook(() => {
      useMcpServers();
      useMcpServer('server');
      useAudioProviders();
    });
    expect(h.query).toHaveBeenCalledTimes(3);
    for (const [options] of h.query.mock.calls) expect(options.enabled).toBe(!impersonating);
  });
});
