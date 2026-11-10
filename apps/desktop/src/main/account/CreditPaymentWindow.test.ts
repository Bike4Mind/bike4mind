import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  created: vi.fn(),
  clearStorageData: vi.fn().mockResolvedValue(undefined),
  setPermissionRequestHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      clearStorageData: mocks.clearStorageData,
      setPermissionRequestHandler: mocks.setPermissionRequestHandler,
    }),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    url = '';
    destroyed = false;
    constructor(options: unknown) {
      super();
      mocks.created(this, options);
    }
    async loadURL(url: string) {
      this.url = url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
    destroy() {
      this.close();
    }
  },
}));

import { openCreditPayment, paymentHtml } from './CreditPaymentWindow';

const payment = { clientSecret: 'pi_123_secret_abc', publishableKey: 'pk_test_123', credits: 33333, price: 20 };

afterEach(() => vi.clearAllMocks());

describe('isolated credit payment window', () => {
  it('serves a protected Stripe page without a desktop preload and tears it down on close', async () => {
    const checkout = openCreditPayment(payment, () => true);
    await vi.waitFor(() => expect(mocks.created).toHaveBeenCalledOnce());
    const [window, options] = mocks.created.mock.calls[0];
    await vi.waitFor(() => expect(window.url).not.toBe(''));
    try {
      expect(options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
      expect(options.webPreferences.preload).toBeUndefined();
      const response = await fetch(window.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const html = await response.text();
      expect(html).toContain('https://js.stripe.com/v3/');
      expect(html).toContain('stripe.confirmPayment');
      expect((await fetch(new URL('/', window.url))).status).toBe(404);
      expect((await fetch(window.url, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${window.url}/return?payment_intent=pi_123`)).status).toBe(200);
      const preventDefault = vi.fn();
      window.webContents.emit('will-navigate', { preventDefault }, 'file:///etc/passwd');
      expect(preventDefault).toHaveBeenCalledOnce();
      for (const event of ['will-navigate', 'will-redirect']) {
        for (const target of [
          'https://example.com',
          'https://checkout.stripe.com.evil.example',
          'not a url',
          'https://user@hooks.stripe.com',
          'https://hooks.stripe.com:444',
        ]) {
          const deny = vi.fn();
          window.webContents.emit(event, { preventDefault: deny }, target);
          expect(deny, target).toHaveBeenCalledOnce();
        }
        for (const target of [
          window.url,
          `${window.url}/return`,
          'https://hooks.stripe.com/3d_secure',
          'https://checkout.stripe.com/pay',
          'https://js.stripe.com/v3',
        ]) {
          const deny = vi.fn();
          window.webContents.emit(event, { preventDefault: deny }, target);
          expect(deny, target).not.toHaveBeenCalled();
        }
      }
      const popupHandler = window.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(popupHandler()).toEqual({ action: 'deny' });
    } finally {
      window.close();
      await checkout;
    }
    expect(mocks.clearStorageData).toHaveBeenCalledOnce();
    await expect(fetch(window.url)).rejects.toThrow();
  });

  it('refuses to open for a changed account', async () => {
    await expect(openCreditPayment(payment, () => false)).rejects.toThrow('Account changed');
    expect(mocks.created).not.toHaveBeenCalled();
  });

  it('closes an open payment window after the account changes', async () => {
    let current = true;
    const checkout = openCreditPayment(payment, () => current);
    await vi.waitFor(() => expect(mocks.created).toHaveBeenCalledOnce());
    const [window] = mocks.created.mock.calls[0];
    current = false;
    await checkout;
    expect(window.isDestroyed()).toBe(true);
  });

  it('escapes inline script data and does not turn closure into payment success', () => {
    const html = paymentHtml(
      { ...payment, publishableKey: '</script><script>bad()</script>' },
      'http://127.0.0.1:1/test',
      'nonce'
    );
    expect(html).not.toContain('</script><script>bad()');
    expect(html).toContain("intent.status==='succeeded'");
    expect(html).not.toContain('window.b4m');
  });
});
