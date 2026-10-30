import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitAfterEachInvocation } from './lambdaRuntimeExit';

const RUNTIME_API = '127.0.0.1:9001';
const CONTEXT = { awsRequestId: 'req/1' };
const RESPONSE_URL = `http://${RUNTIME_API}/2018-06-01/runtime/invocation/req%2F1/response`;
const ERROR_URL = `http://${RUNTIME_API}/2018-06-01/runtime/invocation/req%2F1/error`;

const order: string[] = [];
const fetchImpl = vi.fn();
const exit = vi.fn((code: number) => void order.push(`exit ${code}`));

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  fetchImpl.mockImplementation(async (url: string) => {
    order.push(`post ${url}`);
    return new Response(null, { status: 202 });
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const wrap = (handler: (event: unknown) => Promise<unknown>) =>
  exitAfterEachInvocation(handler, {
    runtimeApi: RUNTIME_API,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    exit,
  });

describe('exitAfterEachInvocation', () => {
  it('posts the result to the Runtime API, and only then ends the runtime process', async () => {
    const handler = vi.fn(async () => ({ status: 'rendered', imageBase64: 'UklGRg==' }));

    await wrap(handler)({ documentUrl: 'https://example.test/doc' }, CONTEXT);

    expect(handler).toHaveBeenCalledWith({ documentUrl: 'https://example.test/doc' }, { deadline: undefined });
    expect(fetchImpl).toHaveBeenCalledWith(
      RESPONSE_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'rendered', imageBase64: 'UklGRg==' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(order).toEqual([`post ${RESPONSE_URL}`, 'exit 0']);
  });

  it('waits for the Runtime API to accept the post before exiting', async () => {
    let accept: (response: Response) => void = () => undefined;
    fetchImpl.mockImplementation(() => new Promise<Response>(resolve => (accept = resolve)));

    const invocation = wrap(async () => ({ status: 'timed-out' }))({}, CONTEXT);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(exit).not.toHaveBeenCalled();

    accept(new Response(null, { status: 202 }));
    await invocation;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('posts a thrown error as a function error, then exits', async () => {
    const failure = new Error('render environment is not clean: unexpected processes');
    failure.name = 'RenderEnvironmentError';

    await wrap(async () => {
      throw failure;
    })({}, CONTEXT);

    expect(fetchImpl).toHaveBeenCalledWith(
      ERROR_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Lambda-Runtime-Function-Error-Type': 'RenderEnvironmentError' }),
        body: JSON.stringify({
          errorType: 'RenderEnvironmentError',
          errorMessage: 'render environment is not clean: unexpected processes',
        }),
      })
    );
    expect(order).toEqual([`post ${ERROR_URL}`, 'exit 0']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invocation failed'), failure);
  });

  it("gives the handler a deadline just short of the invocation's own", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const handler = vi.fn(async () => ({ status: 'timed-out' }));

    await wrap(handler)({}, { ...CONTEXT, getRemainingTimeInMillis: () => 60_000 });
    expect(handler).toHaveBeenCalledWith({}, { deadline: 1_059_000 });

    await wrap(handler)({}, CONTEXT);
    expect(handler).toHaveBeenLastCalledWith({}, { deadline: undefined });
  });

  it.each([
    ['the post fails', () => fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'))],
    ['the Runtime API refuses it', () => fetchImpl.mockResolvedValue(new Response(null, { status: 400 }))],
  ])('still exits when %s, and logs it', async (_label, arrange) => {
    arrange();
    await wrap(async () => ({ status: 'timed-out' }))({}, CONTEXT);
    expect(console.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reads the Runtime API address from the Lambda environment at invoke time', async () => {
    vi.stubEnv('AWS_LAMBDA_RUNTIME_API', '127.0.0.1:9999');
    const handler = exitAfterEachInvocation(async () => ({ status: 'timed-out' }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      exit,
    });
    await handler({}, CONTEXT);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/2018-06-01/runtime/invocation/req%2F1/response',
      expect.anything()
    );
  });

  it.each([
    ['no Runtime API address', '', CONTEXT],
    ['no request id', RUNTIME_API, { awsRequestId: '' }],
  ])('refuses to run the handler at all with %s', async (_label, address, context) => {
    vi.stubEnv('AWS_LAMBDA_RUNTIME_API', address);
    const handler = vi.fn(async () => ({ status: 'timed-out' }));
    const wrapped = exitAfterEachInvocation(handler, { fetchImpl: fetchImpl as unknown as typeof fetch, exit });

    await expect(wrapped({}, context)).rejects.toThrow('only under the Lambda Runtime API');
    expect(handler).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
