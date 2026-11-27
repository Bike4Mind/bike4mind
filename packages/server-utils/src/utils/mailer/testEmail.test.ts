import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  mailerSendTest: vi.fn(),
  logError: vi.fn(),
  resource: {} as Record<string, unknown>,
  invokedCommands: [] as { input: Record<string, unknown> }[],
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = (command: { input: Record<string, unknown> }) => {
      mocks.invokedCommands.push(command);
      return mocks.invoke(command);
    };
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: mocks.logError } }));
vi.mock('./index', () => ({
  default: { sendTestEmail: mocks.mailerSendTest, transport: { kind: 'smtp' } },
}));

import { isMailTestRequest, sendLiveTestEmail } from './testEmail';

const linkEmailSend = (name: string | undefined) => {
  Object.defineProperty(mocks.resource, 'lambdaFunctionNames', {
    value: name === undefined ? {} : { emailSend: name },
    configurable: true,
  });
};

const linkNothing = () => {
  Object.defineProperty(mocks.resource, 'lambdaFunctionNames', {
    get() {
      throw new Error('lambdaFunctionNames is not linked');
    },
    configurable: true,
  });
};

const payloadOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invokedCommands.length = 0;
  vi.stubEnv('B4M_SELF_HOST', 'false');
  linkEmailSend('dev-email-send-fn');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isMailTestRequest', () => {
  it('accepts a payload that carries a recipient address', () => {
    expect(isMailTestRequest({ mailTest: { to: 'qa@example.org' } })).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'mailTest'],
    ['an empty object', {}],
    ['a mailTest without a recipient', { mailTest: {} }],
    ['a recipient that is not a string', { mailTest: { to: 42 } }],
    ['an event bus envelope', { 'detail-type': 'email.send', detail: { to: 'qa@example.org' } }],
    ['an envelope whose detail names mailTest', { 'detail-type': 'email.send', detail: { mailTest: { to: 'a@b.c' } } }],
  ])('rejects %s', (_label, event) => {
    expect(isMailTestRequest(event)).toBe(false);
  });
});

describe('sendLiveTestEmail on self-host', () => {
  beforeEach(() => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
  });

  it('sends in this process and reports the transport that ran the test', async () => {
    mocks.mailerSendTest.mockResolvedValue({ success: true, messageId: 'smtp-1' });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: true,
      messageId: 'smtp-1',
      transport: 'smtp',
    });

    expect(mocks.mailerSendTest).toHaveBeenCalledWith('qa@example.org');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps the transport failure and still names the transport', async () => {
    mocks.mailerSendTest.mockResolvedValue({ success: false, error: 'connection refused' });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'connection refused',
      transport: 'smtp',
    });
  });
});

describe('sendLiveTestEmail on a hosted stage', () => {
  it('invokes the email worker synchronously with the test request and returns its answer', async () => {
    const answer = { success: true, messageId: 'ses-1', transport: 'ses' };
    mocks.invoke.mockResolvedValue({ Payload: payloadOf(answer) });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual(answer);

    expect(mocks.invokedCommands).toHaveLength(1);
    const { FunctionName, InvocationType, Payload } = mocks.invokedCommands[0].input;
    expect(FunctionName).toBe('dev-email-send-fn');
    expect(InvocationType).toBe('RequestResponse');
    expect(JSON.parse(Buffer.from(Payload as Uint8Array).toString('utf8'))).toEqual({
      mailTest: { to: 'qa@example.org' },
    });
    expect(mocks.mailerSendTest).not.toHaveBeenCalled();
  });

  it('passes through a failure the worker reports as its own result', async () => {
    const answer = { success: false, error: 'Mail to test.com is not delivered on this stage.', transport: 'ses' };
    mocks.invoke.mockResolvedValue({ Payload: payloadOf(answer) });

    await expect(sendLiveTestEmail('qa@test.com')).resolves.toEqual(answer);
  });

  it('reports an unlinked worker without invoking anything', async () => {
    linkEmailSend(undefined);

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'The email worker is not linked to this deployment.',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('reports an unlinked worker when reading the link throws', async () => {
    linkNothing();

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'The email worker is not linked to this deployment.',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('logs the worker error message but keeps it out of the result when the function failed', async () => {
    mocks.invoke.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: payloadOf({ errorType: 'Error', errorMessage: 'resource detail example-mail-fn exploded' }),
    });

    const result = await sendLiveTestEmail('qa@example.org');

    expect(result.success).toBe(false);
    expect(result.error).toBe('The email worker failed (Unhandled). Check the email worker logs for details.');
    expect(JSON.stringify(result)).not.toContain('example-mail-fn');
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('resource detail example-mail-fn exploded'));
  });

  it('falls back to the function error kind when the payload has no message', async () => {
    mocks.invoke.mockResolvedValue({ FunctionError: 'Unhandled', Payload: payloadOf({ errorType: 'Error' }) });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'The email worker failed (Unhandled). Check the email worker logs for details.',
    });
  });

  it('falls back to the function error kind when there is no payload at all', async () => {
    mocks.invoke.mockResolvedValue({ FunctionError: 'Unhandled' });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'The email worker failed (Unhandled). Check the email worker logs for details.',
    });
  });

  it.each([
    ['no payload', undefined],
    ['a null payload', payloadOf(null)],
    ['an object without success', payloadOf({ messageId: 'ses-1' })],
    ['a success that is not a boolean', payloadOf({ success: 'yes' })],
  ])('reports no test result for %s', async (_label, Payload) => {
    mocks.invoke.mockResolvedValue({ Payload });

    await expect(sendLiveTestEmail('qa@example.org')).resolves.toEqual({
      success: false,
      error: 'The email worker returned no test result.',
    });
  });
});
