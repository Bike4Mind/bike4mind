import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The two SST links this resolves between are present in DIFFERENT Lambdas, so
 * reading only one is a runtime 502 in one transport and works fine in the other -
 * invisible to typecheck and to every other test. These cases pin both shapes.
 */
const mockResource = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('sst', () => ({
  get Resource() {
    return new Proxy(mockResource.current, {
      get(target, prop) {
        // SST throws on an unlinked resource rather than returning undefined.
        if (!(prop in target)) {
          throw new Error(`"${String(prop)}" is not linked in your sst.config.ts`);
        }
        return target[prop as string];
      },
    });
  },
}));

const { resolveAgentExecutorFunctionName } = await import('./agentExecutorFunctionName');

beforeEach(() => {
  mockResource.current = {};
});

describe('resolveAgentExecutorFunctionName', () => {
  it('uses the direct function link when present (WebSocket route, queue handlers)', () => {
    mockResource.current = { AgentExecutor: { name: 'direct-fn' } };
    expect(resolveAgentExecutorFunctionName()).toBe('direct-fn');
  });

  it('falls back to the lambdaFunctionNames bridge when the function is not linked (frontend server)', () => {
    // This is the exact shape of the frontend server: the direct access THROWS.
    mockResource.current = { lambdaFunctionNames: { agentExecutor: 'bridge-fn' } };
    expect(resolveAgentExecutorFunctionName()).toBe('bridge-fn');
  });

  it('prefers the direct link when a runtime somehow has both', () => {
    mockResource.current = {
      AgentExecutor: { name: 'direct-fn' },
      lambdaFunctionNames: { agentExecutor: 'bridge-fn' },
    };
    expect(resolveAgentExecutorFunctionName()).toBe('direct-fn');
  });

  it('returns undefined when neither link exists, so callers can report a deployment gap', () => {
    expect(resolveAgentExecutorFunctionName()).toBeUndefined();
  });

  it('returns undefined when the bridge exists but carries no executor name', () => {
    mockResource.current = { lambdaFunctionNames: {} };
    expect(resolveAgentExecutorFunctionName()).toBeUndefined();
  });
});
