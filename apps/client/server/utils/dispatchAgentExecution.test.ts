import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchAgentExecution, resolveAgentExecutorTarget } from './dispatchAgentExecution';
const { send, resolveName } = vi.hoisted(() => ({ send: vi.fn(), resolveName: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = send;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('./agentExecutorFunctionName', () => ({ resolveAgentExecutorFunctionName: resolveName }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('executor transport', () => {
  it('rejects incomplete HTTP configuration before allocating execution state', () => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', '');
    expect(() => resolveAgentExecutorTarget()).toThrow(/SECRET/);
  });
  it('preserves the resolved hosted function and async invoke payload', async () => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', '');
    resolveName.mockReturnValue('hosted-fn');
    await dispatchAgentExecution({ executionId: 'e1' });
    expect(send.mock.calls[0][0].input).toMatchObject({ FunctionName: 'hosted-fn', InvocationType: 'Event' });
  });
  it('uses authenticated HTTP without resolving a missing hosted resource', async () => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080/');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await dispatchAgentExecution({ executionId: 'e1', connectionId: 'c1' });
    expect(resolveName).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'http://agentexecutor:8080/execute',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer test-secret' }) })
    );
  });
  it.each([401, 503])('rejects HTTP %s without ambiguous automatic resubmission', async status => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'secret');
    const fetch = vi.fn().mockResolvedValue(new Response('', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(dispatchAgentExecution({ executionId: 'e1' })).rejects.toThrow(String(status));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
