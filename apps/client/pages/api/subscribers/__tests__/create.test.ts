import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

// Middleware is stripped so the handler body runs directly (same pattern as
// pages/api/reg-invites/__tests__/refer.test.ts).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = { use: () => chain, post: (handlerFn: unknown) => handlerFn };
    return chain;
  },
}));

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  create: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Subscriber: { findOne: mocks.findOne, create: mocks.create },
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));

import handler from '@pages/api/subscribers/create';

const submit = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
  return res;
};

const person = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };

describe('/api/subscribers/create - signup source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOne.mockResolvedValue(null);
    mocks.create.mockResolvedValue({});
  });

  it('defaults a plain waitlist signup to subscribe_page and keeps the alert unchanged', async () => {
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ ...person, source: 'subscribe_page' });
    expect(mocks.postMessageToSlack.mock.calls[0][0]).not.toContain('registration was closed');
  });

  it('stores a closed-signup source and flags it in the admin alert', async () => {
    await submit({ ...person, source: 'oauth_signup_closed' });

    expect(mocks.create).toHaveBeenCalledWith({ ...person, source: 'oauth_signup_closed' });
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('registration was closed');
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('oauth_signup_closed');
  });

  it('escapes subscriber-supplied names and email in the admin alert', async () => {
    await submit({ firstName: '<!channel>', lastName: 'A&B', email: 'x@example.com' });

    const text = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(text).toContain('&lt;!channel&gt; A&amp;B');
    expect(text).not.toContain('<!channel>');
  });

  it('rejects a source outside the known set rather than storing caller-chosen text', async () => {
    await expect(submit({ ...person, source: 'anything-goes' })).rejects.toBeInstanceOf(ZodError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
