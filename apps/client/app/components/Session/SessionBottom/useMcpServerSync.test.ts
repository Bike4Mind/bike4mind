import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = { enabledMcpServers: ['notion'], disabledMcpConnections: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const connections = { value: { all: [] as Array<{ slug: string }>, offered: [], loaded: true } };
  return { state, useLLM, connections };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({ data: [{ name: 'notion', enabled: true }] }),
}));
vi.mock('@client/app/hooks/useComposerMcpConnections', () => ({
  useComposerMcpConnections: () => mocks.connections.value,
}));

import { useMcpServerSync } from './useMcpServerSync';

beforeEach(() => {
  mocks.useLLM.setState.mockClear();
  mocks.state.disabledMcpConnections = ['acme', 'gone'];
  mocks.connections.value = { all: [{ slug: 'acme' }, { slug: 'docs' }], offered: [], loaded: true };
});

describe('useMcpServerSync - custom connector opt-outs', () => {
  it('drops the slug of a connector that no longer exists, so one reusing it starts on', () => {
    renderHook(() => useMcpServerSync());
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ disabledMcpConnections: ['acme'] });
  });

  it('prunes nothing before the connection list has loaded', () => {
    mocks.connections.value = { all: [], offered: [], loaded: false };
    renderHook(() => useMcpServerSync());
    expect(mocks.useLLM.setState).not.toHaveBeenCalledWith(
      expect.objectContaining({ disabledMcpConnections: expect.anything() })
    );
  });

  it('writes nothing when every switched-off slug still has its connector', () => {
    mocks.state.disabledMcpConnections = ['acme'];
    renderHook(() => useMcpServerSync());
    expect(mocks.useLLM.setState).not.toHaveBeenCalled();
  });
});
