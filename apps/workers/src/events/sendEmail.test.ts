import { beforeEach, expect, it, vi } from 'vitest';

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

type Attachment = { filename: string; content: string; contentType: string };

async function send(category?: 'otc', attachments?: Attachment[]) {
  // The wrapper supplies event context; this test exercises only its wrapped callback.
  const callback = handler as unknown as (event: unknown, logger: typeof mocks.logger) => Promise<void>;
  await callback(
    { properties: { to: 'test@example.org', subject: 'Test', body: 'Body', category, attachments } },
    mocks.logger
  );
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
