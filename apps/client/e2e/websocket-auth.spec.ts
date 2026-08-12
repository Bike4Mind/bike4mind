import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestRunId, getE2ETestId } from './helpers/test-users';
import { apiCreateTestUser } from './helpers/api';

/**
 * The WebSocket verifiers ($connect, subscribe_query, unsubscribe_query) enforce the same
 * token gates as the REST strategy: `typ` and the tokenVersion kill switch. These tests pin
 * the observable end of that from a real deploy - a current token still gets a working
 * realtime subscription, and a token revoked by logout no longer completes the handshake.
 *
 * Each test mints its own throwaway account: revoking bumps tokenVersion for ALL of a user's
 * tokens, so a shared spec user would have its session killed for every parallel spec. The
 * retry index is baked into the identity because createUser rejects a duplicate email, so a
 * retry would otherwise die during setup. The email mirrors the setup convention
 * (`...-<id>-e2e@test.com`) so global-teardown's cleanup sweep matches it.
 */
async function createWsUser(request: APIRequestContext, label: string) {
  const e2eId = getE2ETestId();
  const idSuffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
  const slug = `wsauth-${label}${test.info().retry}`;
  const email = `${slug}-${idSuffix}-e2e@test.com`;
  const result = await apiCreateTestUser(request, {
    username: `${slug}-${idSuffix}`,
    email,
    name: `WsAuth ${label} ${idSuffix}`,
    password: `E2eWsAuth${label}Pass123!`,
    isAdmin: false,
  });
  return {
    email,
    userId: (result.user.id || result.user._id) as string,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  };
}

const baseURL = () => process.env.API_URL || 'http://localhost:3000';

async function getWebsocketUrl(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.get(`${baseURL()}/api/settings/serverConfig`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) throw new Error(`serverConfig failed: ${response.status()}`);
  const { websocketUrl } = await response.json();
  if (!websocketUrl) throw new Error('serverConfig returned no websocketUrl');
  return websocketUrl;
}

/** Logout revokes every token the user holds by bumping tokenVersion server-side. */
async function apiLogout(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.get(`${baseURL()}/api/logout`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) throw new Error(`Logout failed: ${response.status()}`);
}

/**
 * Open a socket in the page context (the browser's WebSocket is the only WS client available
 * to Playwright) and report whether the handshake completed. API Gateway rejects a failed
 * $connect at the handshake, which surfaces as an error/close rather than an open.
 */
async function tryWsConnect(page: Page, wsUrl: string, token: string): Promise<boolean> {
  return page.evaluate(
    ([url, accessToken, timeoutMs]) =>
      new Promise<boolean>(resolve => {
        const socket = new WebSocket(`${url}?token=${encodeURIComponent(accessToken as string)}`);
        const finish = (opened: boolean) => {
          clearTimeout(timer);
          try {
            socket.close();
          } catch {
            // already closed
          }
          resolve(opened);
        };
        const timer = setTimeout(() => finish(false), timeoutMs as number);
        socket.onopen = () => finish(true);
        socket.onerror = () => finish(false);
        socket.onclose = () => finish(false);
      }),
    [wsUrl, token, TIMEOUTS.ELEMENT_STATE] as const
  );
}

/**
 * Full subscribe round-trip: connect, subscribe to the caller's own user document with
 * fetchInitialData, and resolve on the first data_update frame. Exercises the subscribe
 * verifier end to end, then unsubscribes and reports whether the socket survived it.
 */
async function subscribeRoundTrip(
  page: Page,
  wsUrl: string,
  token: string,
  userId: string
): Promise<{ receivedUpdate: boolean; openAfterUnsubscribe: boolean }> {
  return page.evaluate(
    ([url, accessToken, id, timeoutMs]) =>
      new Promise<{ receivedUpdate: boolean; openAfterUnsubscribe: boolean }>(resolve => {
        const subscriptionId = `e2e-ws-auth-${id}`;
        const socket = new WebSocket(`${url}?token=${encodeURIComponent(accessToken as string)}`);
        let receivedUpdate = false;
        const finish = () => {
          clearTimeout(timer);
          if (receivedUpdate && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'unsubscribe_query', accessToken, subscriptionId }));
          }
          // The unsubscribe ack is a status code on the Lambda, not a frame, so settle briefly
          // and report whether the socket is still open - a rejected frame must not kill it.
          setTimeout(() => {
            const openAfterUnsubscribe = socket.readyState === WebSocket.OPEN;
            try {
              socket.close();
            } catch {
              // already closed
            }
            resolve({ receivedUpdate, openAfterUnsubscribe });
          }, 1_000);
        };
        const timer = setTimeout(finish, timeoutMs as number);

        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              action: 'subscribe_query',
              accessToken,
              subscriptionId,
              collectionName: 'users',
              query: { _id: id },
              fields: { email: true },
              fetchInitialData: true,
            })
          );
        socket.onmessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.action === 'data_update' && message.subscriptionId === subscriptionId) {
            receivedUpdate = true;
            finish();
          }
        };
        socket.onerror = finish;
      }),
    [wsUrl, token, userId, TIMEOUTS.ACTION] as const
  );
}

test.describe('WebSocket token enforcement', () => {
  test('a current access token connects and receives its subscription data', async ({ page, request }) => {
    const user = await createWsUser(request, 'ok');
    const wsUrl = await getWebsocketUrl(request, user.accessToken);
    await page.goto('/login');

    expect(await tryWsConnect(page, wsUrl, user.accessToken)).toBe(true);

    const { receivedUpdate, openAfterUnsubscribe } = await subscribeRoundTrip(
      page,
      wsUrl,
      user.accessToken,
      user.userId
    );
    expect(receivedUpdate).toBe(true);
    expect(openAfterUnsubscribe).toBe(true);
  });

  test('a token revoked by logout is refused at connect', async ({ page, request }) => {
    const user = await createWsUser(request, 'revoked');
    const wsUrl = await getWebsocketUrl(request, user.accessToken);
    await page.goto('/login');

    // Positive control first: the same token must work before the revoke, so a failure below
    // is the kill switch firing and not a broken deploy or a bad URL.
    expect(await tryWsConnect(page, wsUrl, user.accessToken)).toBe(true);

    await apiLogout(request, user.accessToken);

    expect(await tryWsConnect(page, wsUrl, user.accessToken)).toBe(false);
  });

  test('a refresh token is refused at connect', async ({ page, request }) => {
    const user = await createWsUser(request, 'refreshtok');
    const wsUrl = await getWebsocketUrl(request, user.accessToken);
    await page.goto('/login');

    // Session-store refresh tokens are the opaque `<sid>.<secret>` form, so this is refused
    // before the `typ` gate is even reached. The gate itself is unit-tested against a
    // same-secret JWT refresh token (verifyWsAccessToken.test.ts, connect.test.ts), which is
    // the case this cannot construct from the browser - it has no signing secret.
    expect(await tryWsConnect(page, wsUrl, user.refreshToken)).toBe(false);
  });
});
