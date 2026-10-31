import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import jwt from 'jsonwebtoken';
import open from 'open';
import { isBrowserOpenableUrl, isOnApiOrigin, LoginFlow } from './LoginFlow';
import type { ConfigStore } from '../storage/ConfigStore';

const oauth = vi.hoisted(() => ({ initiateDeviceFlow: vi.fn(), waitForAuthorization: vi.fn() }));
const identify = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn());

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/copyToClipboard', () => ({ copyToClipboard: copy }));
vi.mock('../auth/OAuthClient', () => ({
  OAuthClient: class {
    initiateDeviceFlow = oauth.initiateDeviceFlow;
    waitForAuthorization = oauth.waitForAuthorization;
  },
}));
vi.mock('../auth/ApiClient', () => ({
  ApiClient: class {
    get = identify;
  },
}));

describe('isBrowserOpenableUrl', () => {
  it('accepts https URLs', () => {
    expect(isBrowserOpenableUrl('https://auth.example.com/device?code=ABC')).toBe(true);
  });

  it('accepts http only on localhost (dev)', () => {
    expect(isBrowserOpenableUrl('http://localhost:3000/verify')).toBe(true);
    expect(isBrowserOpenableUrl('http://127.0.0.1:3000/verify')).toBe(true);
    expect(isBrowserOpenableUrl('http://evil.example.com/verify')).toBe(false);
  });

  it('rejects non-web schemes a hostile server could inject', () => {
    expect(isBrowserOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isBrowserOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isBrowserOpenableUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isBrowserOpenableUrl('not a url')).toBe(false);
  });
});

describe('isOnApiOrigin', () => {
  const api = 'https://app.example.com';

  it('accepts the same origin', () => {
    expect(isOnApiOrigin('https://app.example.com/activate?code=X', api)).toBe(true);
    expect(isOnApiOrigin('http://localhost:3000/activate', 'http://localhost:3000')).toBe(true);
  });

  it('rejects a different host, port or scheme', () => {
    expect(isOnApiOrigin('https://evil.example.com/activate', api)).toBe(false);
    expect(isOnApiOrigin('https://app.example.com:8443/activate', api)).toBe(false);
    expect(isOnApiOrigin('http://app.example.com/activate', api)).toBe(false);
    expect(isOnApiOrigin('http://127.0.0.1:3000/activate', 'http://localhost:3000')).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(isOnApiOrigin('https://app.example.com/activate', 'not a url')).toBe(false);
    expect(isOnApiOrigin('not a url', api)).toBe(false);
  });
});

describe('LoginFlow', () => {
  const tokens = {
    access_token: jwt.sign({ id: 'u1' }, 'k'),
    refresh_token: 'r',
    expires_in: 3600,
  };
  const deviceFlowFor = (base: string) => ({
    device_code: 'dc',
    user_code: 'ABCD-1234',
    verification_uri: `${base}/activate`,
    verification_uri_complete: `${base}/activate?code=ABCD-1234`,
    expires_in: 600,
    interval: 5,
  });
  const configStore = { setAuthTokens: vi.fn().mockResolvedValue(undefined) } as unknown as ConfigStore;

  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(open).mockClear();
    identify.mockReset();
    oauth.waitForAuthorization.mockReset().mockResolvedValue(tokens);
  });

  it('opens a same-origin URL and names the bound account and host', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    identify.mockResolvedValue({ user: { email: 'a@b.com', username: 'ab' } });
    // Hold authorization until the waiting screen has rendered, as real polling does.
    let authorize!: (t: typeof tokens) => void;
    oauth.waitForAuthorization.mockReturnValue(new Promise(resolve => (authorize = resolve)));
    const onSuccess = vi.fn();
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={onSuccess} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://app.example.com/activate?code=ABCD-1234'));
    expect(lastFrame()).not.toContain('Not opening browser');
    authorize(tokens);
    await vi.waitFor(() => expect(lastFrame()).toContain('Logged in as a@b.com on app.example.com'));
    expect(identify).toHaveBeenCalledWith('/api/identify');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('falls back to the user ID when identify fails, without blocking success', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    identify.mockRejectedValue(new Error('boom'));
    const onSuccess = vi.fn();
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={onSuccess} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Logged in as user u1 on app.example.com'));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('does not open a foreign-origin URL and warns with both origins', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://evil.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Not opening browser'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('https://evil.example.com');
    expect(frame).toContain('https://app.example.com');
    expect(frame).toContain('ABCD-1234');
    // The auto-open effect runs after the frame renders; give it a chance to (wrongly) fire.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to URL and code for a foreign origin, without showing or copying the link', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://evil.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Not opening browser'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('The server asked you to visit:');
    expect(frame).toContain('https://evil.example.com/activate');
    expect(frame).not.toContain('activate?code=');
    expect(frame).not.toContain('Press c');
    stdin.write('c');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(copy).not.toHaveBeenCalled();
  });

  it('drops a foreign-origin link when only verification_uri is trusted, and copies the code', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue({
      ...deviceFlowFor('https://app.example.com'),
      verification_uri_complete: 'https://evil.example.com/activate?code=ABCD-1234',
    });
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    copy.mockResolvedValue('clipboard');
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the code'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('verification URL origin https://evil.example.com does not match');
    expect(frame).toContain('Please visit:');
    expect(frame).toContain('https://app.example.com/activate');
    expect(frame).not.toContain('activate?code=');
    stdin.write('c');
    await vi.waitFor(() => expect(lastFrame()).toContain('Code copied to clipboard'));
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores Ctrl+C and Alt+C', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    copy.mockResolvedValue('clipboard');
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the link'));
    stdin.write('\x03');
    stdin.write('\x1bc');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(copy).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Press c to copy the link');
  });

  it('ignores c while a copy is still running', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    let finish!: (r: 'clipboard') => void;
    copy.mockReturnValueOnce(new Promise(resolve => (finish = resolve))).mockResolvedValue('clipboard');
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the link'));
    stdin.write('c');
    stdin.write('c');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(copy).toHaveBeenCalledTimes(1);
    finish('clipboard');
    await vi.waitFor(() => expect(lastFrame()).toContain('Link copied to clipboard'));
    stdin.write('c');
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
  });

  it('names the scheme, not an origin mismatch, for a same-origin plain-http URL', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('http://b4m.internal'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="http://b4m.internal" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Not opening browser'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('is not https');
    expect(frame).not.toContain('does not match');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to URL and code, without building or opening a link, when verification_uri_complete is omitted', async () => {
    const { verification_uri_complete: _omitted, ...partial } = deviceFlowFor('https://app.example.com');
    oauth.initiateDeviceFlow.mockResolvedValue(partial);
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('ABCD-1234'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('Please visit:');
    expect(frame).toContain('https://app.example.com/activate');
    expect(frame).not.toContain('activate?code=');
    expect(frame).not.toContain('Not opening browser');
    expect(frame).toContain('Press c to copy the code');
    copy.mockResolvedValue('clipboard');
    stdin.write('c');
    await vi.waitFor(() => expect(lastFrame()).toContain('Code copied to clipboard'));
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
    expect(open).not.toHaveBeenCalled();
  });

  it('names a link without a verification_uri accurately and does not open it', async () => {
    const { verification_uri: _omitted, ...partial } = deviceFlowFor('https://app.example.com');
    oauth.initiateDeviceFlow.mockResolvedValue(partial);
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Not opening browser'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('the server sent a sign-in link but no verification URL');
    expect(frame).not.toContain('did not return a verification URL');
    expect(frame).toContain('https://app.example.com/activate?code=ABCD-1234');
    expect(frame).not.toContain('Or open');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });

  it('warns when the server returns neither URI', async () => {
    const {
      verification_uri: _uri,
      verification_uri_complete: _link,
      ...partial
    } = deviceFlowFor('https://app.example.com');
    oauth.initiateDeviceFlow.mockResolvedValue(partial);
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Not opening browser'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('the server did not return a verification URL');
    expect(frame).not.toContain('Press c');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the one-click link first and the URL plus code as the fallback', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the link'));
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    const linkAt = frame.indexOf('https://app.example.com/activate?code=ABCD-1234');
    const fallbackAt = frame.indexOf('Or open https://app.example.com/activate and enter this code:');
    expect(linkAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(linkAt);
    expect(frame.indexOf('ABCD-1234', fallbackAt)).toBeGreaterThan(fallbackAt);
  });

  it.each([
    ['clipboard', 'Link copied to clipboard'],
    ['terminal', 'Sent the link to your terminal clipboard'],
    ['failed', 'Copy failed, select the link above'],
  ] as const)('copies the full link on c and reports %s', async (result, message) => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    copy.mockResolvedValue(result);
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the link'));
    stdin.write('x');
    stdin.write('c');
    await vi.waitFor(() => expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain(message));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith('https://app.example.com/activate?code=ABCD-1234');
  });

  it('reports a copy failure when the clipboard helper throws', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    copy.mockRejectedValue(new Error('boom'));
    const { lastFrame, stdin } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('Press c to copy the link'));
    stdin.write('c');
    await vi.waitFor(() => expect(lastFrame()).toContain('Copy failed, select the link above'));
  });

  it('strips terminal control characters from server-supplied display strings', async () => {
    const flow = deviceFlowFor('https://evil.example.com');
    oauth.initiateDeviceFlow.mockResolvedValue({
      ...flow,
      verification_uri: `${flow.verification_uri}\u001b]0;pwned\u0007`,
      user_code: '\u001b[2JABCD-1234',
    });
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('ABCD-1234'));
    expect(lastFrame()).not.toContain('\u001b]0;pwned');
    expect(lastFrame()).not.toContain('\u001b[2J');
    expect(lastFrame()).toContain(']0;pwned');
  });

  it('strips terminal control characters from a server error message', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('https://app.example.com'));
    oauth.waitForAuthorization.mockRejectedValue(new Error('\u001b]0;pwned\u0007boom'));
    const onError = vi.fn();
    const { lastFrame } = render(
      <LoginFlow apiUrl="https://app.example.com" configStore={configStore} onSuccess={vi.fn()} onError={onError} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('boom'));
    expect(lastFrame()).not.toContain('\u001b]0;pwned');
    expect(onError.mock.calls[0][0].message).toBe(']0;pwnedboom');
  });

  it('opens a localhost dev URL on the matching origin', async () => {
    oauth.initiateDeviceFlow.mockResolvedValue(deviceFlowFor('http://localhost:3000'));
    oauth.waitForAuthorization.mockReturnValue(new Promise(() => {}));
    render(
      <LoginFlow apiUrl="http://localhost:3000" configStore={configStore} onSuccess={vi.fn()} onError={vi.fn()} />
    );

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('http://localhost:3000/activate?code=ABCD-1234'));
  });
});
