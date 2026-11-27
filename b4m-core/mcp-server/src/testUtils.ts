import { vi } from 'vitest';
import type { ToolContext } from './context';
import { parseToolsets } from './toolsets';
import type { ApiTransport, TransportResponse } from './transport/types';

export const mockTransport = (impl?: ApiTransport['call']) => {
  const call = vi.fn<ApiTransport['call']>(impl ?? (async () => ({ status: 200, headers: {} })));
  return { call } satisfies ApiTransport & { call: typeof call };
};

export const json = (status: number, body: unknown): TransportResponse => ({ status, headers: {}, json: body });

export const makeCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  transport: mockTransport(),
  kind: 'stdio',
  scopes: 'all',
  exposureCeiling: 'private',
  toolsets: parseToolsets('all'),
  waitBudgetSeconds: 900,
  baseUrl: 'https://app.example.com',
  ...over,
});
