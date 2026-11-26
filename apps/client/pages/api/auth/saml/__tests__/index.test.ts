import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handler: undefined as Handler | undefined,
  findByIdWithSecrets: vi.fn(),
  setupSamlStrategy: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (fn: Handler) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => () => undefined }));
vi.mock('passport', () => ({ default: { authenticate: (...a: unknown[]) => h.authenticate(...a) } }));
vi.mock('@bike4mind/database', () => ({
  identityProviderRepository: { findByIdWithSecrets: (...a: unknown[]) => h.findByIdWithSecrets(...a) },
}));
vi.mock('@server/auth/auth', () => ({ setupSamlStrategy: (...a: unknown[]) => h.setupSamlStrategy(...a) }));

import '../index';

const errorSpy = vi.fn();

function run(query: Record<string, string>) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: 'GET', query });
  (req as unknown as Record<string, unknown>).logger = { error: errorSpy, warn: vi.fn(), info: vi.fn() };
  return { done: h.handler!(req, res), res };
}

describe('GET /api/auth/saml', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy.mockReset();
    h.setupSamlStrategy.mockReturnValue('saml-idp-1');
    h.authenticate.mockReturnValue(vi.fn());
  });

  // A thrown HTTP error reaches the shared error handler, which answers with its status and logs
  // every 4xx at warn.
  it('answers an unknown IdP with 404 and no error log', async () => {
    h.findByIdWithSecrets.mockResolvedValue(null);

    await expect(run({ idp: 'unknown' }).done).rejects.toMatchObject({ statusCode: 404 });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('answers an inactive IdP with 404 and no error log', async () => {
    h.findByIdWithSecrets.mockResolvedValue({ id: 'idp-1', isActive: false, type: 'saml', samlConfig: {} });

    await expect(run({ idp: 'idp-1' }).done).rejects.toMatchObject({ statusCode: 404 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('answers a missing idp parameter with 400', async () => {
    await expect(run({}).done).rejects.toMatchObject({ statusCode: 400 });
    expect(h.findByIdWithSecrets).not.toHaveBeenCalled();
  });

  it('answers a non-SAML IdP with 400 and no error log', async () => {
    h.findByIdWithSecrets.mockResolvedValue({ id: 'idp-1', isActive: true, type: 'okta' });

    await expect(run({ idp: 'idp-1' }).done).rejects.toMatchObject({ statusCode: 400 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a failed IdP lookup at error and redirects to the login page', async () => {
    h.findByIdWithSecrets.mockRejectedValue(new Error('db down'));

    const { done, res } = run({ idp: 'idp-1' });
    await done;

    expect(errorSpy).toHaveBeenCalledWith('SAML identity provider lookup failed', { error: expect.any(Error) });
    expect(res._getRedirectUrl()).toBe('/login?error=saml_setup_failed');
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('starts the SAML flow for an active SAML IdP', async () => {
    h.findByIdWithSecrets.mockResolvedValue({ id: 'idp-1', isActive: true, type: 'saml', samlConfig: {} });

    await run({ idp: 'idp-1' }).done;

    expect(h.authenticate).toHaveBeenCalledWith('saml-idp-1', expect.anything());
  });

  it('binds the login to this browser: a nonce cookie whose hash rides RelayState', async () => {
    h.findByIdWithSecrets.mockResolvedValue({ id: 'idp-1', isActive: true, type: 'saml', samlConfig: {} });

    const { done, res } = run({ idp: 'idp-1' });
    await done;

    const cookie = String(res.getHeader('Set-Cookie'));
    const nonce = /^b4m_saml_nonce=([0-9a-f]+);/.exec(cookie)?.[1];
    expect(nonce).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=None; Secure');
    const relayState = new URLSearchParams(h.authenticate.mock.calls[0][1].additionalParams.RelayState);
    expect(relayState.get('idp')).toBe('idp-1');
    expect(relayState.get('nh')).toBe(createHash('sha256').update(nonce!).digest('hex'));
  });

  it('still logs an unexpected strategy setup failure at error and redirects to the login page', async () => {
    h.findByIdWithSecrets.mockResolvedValue({ id: 'idp-1', isActive: true, type: 'saml', samlConfig: {} });
    h.setupSamlStrategy.mockImplementation(() => {
      throw new Error('bad certificate');
    });

    const { done, res } = run({ idp: 'idp-1' });
    await done;

    expect(errorSpy).toHaveBeenCalledWith('SAML authentication error', { error: expect.any(Error) });
    expect(res._getRedirectUrl()).toBe('/login?error=saml_setup_failed');
  });
});
