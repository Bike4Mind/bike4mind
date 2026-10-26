import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn(), logger: { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (fn: unknown) => fn }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { schema: { parse: (value: unknown) => value } } } }));
vi.mock('@server/utils/mailer', () => ({ default: { sendEmail: mocks.send } }));
import { handler } from './sendEmail';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OTC_SES_CONFIGURATION_SET', 'synthetic-otc');
  mocks.send.mockResolvedValue({ messageId: 'synthetic-id' });
});
afterEach(() => vi.unstubAllEnvs());

async function send(category?: 'otc') {
  // The wrapper supplies event context; this test exercises only its wrapped callback.
  const callback = handler as unknown as (event: unknown, logger: typeof mocks.logger) => Promise<void>;
  await callback({ properties: { to: 'test@example.org', subject: 'Test', body: 'Body', category } }, mocks.logger);
}

it('adds the SES configuration header only to explicitly categorized OTC mail', async () => {
  await send('otc');
  expect(mocks.send).toHaveBeenCalledWith('test@example.org', {
    subject: 'Test',
    html: 'Body',
    headers: { 'X-SES-CONFIGURATION-SET': 'synthetic-otc' },
  });
  mocks.send.mockClear();
  await send();
  expect(mocks.send).toHaveBeenCalledWith('test@example.org', { subject: 'Test', html: 'Body' });
});

it('leaves mail unchanged when SES monitoring is not configured', async () => {
  vi.stubEnv('OTC_SES_CONFIGURATION_SET', '');
  await send('otc');
  expect(mocks.send).toHaveBeenCalledWith('test@example.org', { subject: 'Test', html: 'Body' });
});
