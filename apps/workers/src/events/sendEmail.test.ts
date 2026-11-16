import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn(), logger: { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  EmailEvents: { Send: { schema: { parse: (value: unknown) => value } } },
}));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: mocks.send } }));
import { handler } from './sendEmail';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({ messageId: 'synthetic-id' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Attachment = { filename: string; content: string; contentType: string };

async function send(category?: 'otc', attachments?: Attachment[], to = 'test@example.org') {
  // The wrapper supplies event context; this test exercises only its wrapped callback.
  const callback = handler as unknown as (event: unknown, logger: typeof mocks.logger) => Promise<void>;
  await callback({ properties: { to, subject: 'Test', body: 'Body', category, attachments } }, mocks.logger);
}

it('passes the category through so the transport can pick the configuration set', async () => {
  await send('otc');
  expect(mocks.send).toHaveBeenCalledWith('test@example.org', { subject: 'Test', html: 'Body' }, { category: 'otc' });
  mocks.send.mockClear();
  await send();
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    { subject: 'Test', html: 'Body' },
    { category: undefined }
  );
});

it('decodes base64 attachments back into buffers', async () => {
  await send(undefined, [
    { filename: 'a.txt', content: Buffer.from('hello').toString('base64'), contentType: 'text/plain' },
  ]);
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    {
      subject: 'Test',
      html: 'Body',
      attachments: [{ filename: 'a.txt', content: Buffer.from('hello'), contentType: 'text/plain' }],
    },
    { category: undefined }
  );
});

it('logs a delivery failure without throwing', async () => {
  mocks.send.mockResolvedValue(false);
  await send();
  expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Email delivery failed'), expect.anything());
});

it('skips delivery to a sink domain and logs the skip instead of a failure', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await send('otc', undefined, 'alice-e2e@test.com');
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.logger.error).not.toHaveBeenCalled();
  expect(mocks.logger.info).toHaveBeenCalledWith(
    expect.stringContaining('sink domain'),
    expect.objectContaining({ to: 'alice-e2e@test.com', sinkDomain: 'test.com' })
  );
});

it('still delivers to other domains when a sink list is set', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await send(undefined, undefined, 'alice@mail.test.com');
  expect(mocks.send).toHaveBeenCalledWith(
    'alice@mail.test.com',
    { subject: 'Test', html: 'Body' },
    { category: undefined }
  );
});

it('delivers everything when no sink list is set', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', '');
  await send(undefined, undefined, 'alice-e2e@test.com');
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
