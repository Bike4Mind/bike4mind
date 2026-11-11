import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPut = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: mockPut, get: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { tutorialAdminModulesKey } from '@client/app/components/tutorial/tutorialKeys';
import { useSetTutorialModule } from './useTutorialModules';

const BASE = '/api/test-tutorials';

describe('useSetTutorialModule', () => {
  it('refetches the stored modules when the switch is refused', async () => {
    mockPut.mockRejectedValue(new Error('409'));
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetTutorialModule(BASE), { wrapper });
    result.current.mutate({ moduleId: 'alpha', enabled: false, reason: 'x' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: tutorialAdminModulesKey(BASE) }));
  });
});
