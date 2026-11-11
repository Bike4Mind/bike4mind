import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateTestUser } from './helpers/api';
import { readPodRollEnv, runRollCommand, RealtimeSocketTracker, type PodRollEnv } from './helpers/selfhost-pod-roll';

/**
 * Self-host only, run through selfhost-pod-roll.config.ts against a Kubernetes target (see "Pod
 * roll reconnect check" in selfhost/kubernetes/README.md). Replaces the app pod and then the
 * WebSocket gateway pod in the middle of one chat, and requires the same page - never reloaded -
 * to be back on a working realtime socket and to get a streamed reply after each.
 *
 * The two rolls are observed differently on purpose. The gateway holds the browser socket, so an
 * app roll does not have to drop it: the check requires a socket that carries traffic after the
 * roll, reused or reopened. A gateway roll must drop it, so there the check requires the old socket
 * closed and a new one opened and answered (WebsocketContext shouldReconnect / reconnectInterval).
 *
 * Mutation proof: point SELFHOST_ROLL_WS_CMD at a command that stops the gateway without bringing
 * it back. The reconnect wait after the gateway roll must then fail.
 */

/** Set before the first roll and read at the end: a full page load would wipe it. */
const SENTINEL_KEY = '__podRollSentinel';

interface ChatHistoryItem {
  prompt?: string | null;
  reply?: string | null;
  replies?: string[] | null;
}

async function fetchHistory(request: APIRequestContext, token: string, sessionId: string): Promise<ChatHistoryItem[]> {
  const response = await request.get(`/api/sessions/${sessionId}/chat`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    // The access token minted at the start lives 30 minutes; a run slower than that ends here.
    const hint = response.status() === 401 ? ' (the access token may have expired during a slow run)' : '';
    throw new Error(`Reading the chat history failed: ${response.status()}${hint}`);
  }
  const body: { data?: ChatHistoryItem[] } = await response.json();
  return body.data ?? [];
}

const hasReply = (item: ChatHistoryItem) => !!item.reply?.trim() || !!item.replies?.some(r => r.trim());

// Read before any fixture runs, so a missing setting is reported as such and not after a browser launch.
let env: PodRollEnv;
test.beforeAll(() => {
  env = readPodRollEnv();
});

test('the chat client reconnects and resumes when the app and WebSocket pods roll', async ({
  page,
  request,
  authState,
  chatPage,
}) => {
  const tracker = new RealtimeSocketTracker(page);
  // Minted here rather than through the suite's setup projects, which this config does not run.
  // The `-<digits>-e2e@test.com` shape is what the /api/test/cleanup sweep reclaims.
  const runMarker = `podroll-${Date.now()}`;
  const created = await apiCreateTestUser(request, {
    username: runMarker,
    email: `${runMarker}-e2e@test.com`,
    name: `Pod roll ${runMarker}`,
    password: `E2ePodRoll${runMarker}!`,
    isAdmin: false,
  });
  const user = { accessToken: created.accessToken, userId: String(created.user.id || created.user._id) };
  authState.current = user;
  const prompts: string[] = [];
  // One chat turn; returns the time it was sent. The marker makes each prompt findable in history.
  // ChatPage reloads the page when the send button never enables; that wipes the sentinel below,
  // so such a recovery fails the no-reload step instead of hiding a client that did not resume.
  const sendTurn = async (label: string) => {
    const prompt = `In two short sentences, describe a bicycle. Reference: ${runMarker}-${label}`;
    prompts.push(prompt);
    const sentAt = Date.now();
    const reply = await chatPage.sendMessageAndWaitForResponse(prompt);
    expect(reply.trim(), `the ${label} turn produced no reply text`).not.toBe('');
    return sentAt;
  };
  /** Poll a tracker condition; the failure lists the sockets as they are when the wait gives up. */
  const waitForSocket = async (condition: () => boolean, what: string) => {
    try {
      await expect.poll(condition, { timeout: env.reconnectTimeoutMs }).toBe(true);
    } catch {
      throw new Error(`${what} within ${env.reconnectTimeoutMs}ms. Sockets: ${tracker.describe()}`);
    }
  };
  const expectLiveSocket = (since: number, what: string) => waitForSocket(() => !!tracker.liveSince(since), what);

  await test.step('start a chat and get a streamed reply', async () => {
    await page.goto('/new');
    await expectLiveSocket(0, 'the client never got a working realtime socket before any roll');
    const sentAt = await sendTurn('before');
    expect(tracker.streamFramesSince(sentAt), 'the first reply was not streamed over the socket').toBeGreaterThan(0);
    await page.waitForURL(/\/notebooks\/[^/]+/, { timeout: TIMEOUTS.ACTION });
    await page.evaluate(([key, value]) => Reflect.set(window, key, value), [SENTINEL_KEY, runMarker] as const);
  });
  const sessionId = new URL(page.url()).pathname.split('/')[2];

  await test.step('roll the app pod', async () => {
    await runRollCommand('app', env.appRollCommand, env.rollTimeoutMs);
    const rolledAt = Date.now();
    await expectLiveSocket(rolledAt, 'no realtime socket carried traffic after the app pod rolled');
    const sentAt = await sendTurn('after-app');
    expect(
      tracker.streamFramesSince(sentAt),
      'the reply after the app roll was not streamed over the socket'
    ).toBeGreaterThan(0);
  });

  await test.step('roll the WebSocket gateway pod', async () => {
    const rollStartedAt = Date.now();
    const before = tracker.sockets.filter(s => s.closedAt === null);
    await runRollCommand('ws', env.wsRollCommand, env.rollTimeoutMs);
    await waitForSocket(
      () => !!tracker.reconnectedSince(rollStartedAt),
      'the client did not reconnect after the gateway pod rolled'
    );
    expect(
      before.every(s => s.closedAt !== null),
      `a socket from before the gateway roll is still open, so the gateway pod was not replaced. Sockets: ${tracker.describe()}`
    ).toBe(true);
    const sentAt = await sendTurn('after-ws');
    expect(
      tracker.streamFramesSince(sentAt, rollStartedAt),
      'the reply after the gateway roll was not streamed over the reconnected socket'
    ).toBeGreaterThan(0);
  });

  await test.step('the page was never reloaded', async () => {
    const sentinel = await page.evaluate(key => Reflect.get(window, key), SENTINEL_KEY);
    expect(sentinel, 'the page was reloaded during the rolls').toBe(runMarker);
  });

  await test.step('persisted history is intact', async () => {
    const history = await fetchHistory(request, user.accessToken, sessionId);
    for (const prompt of prompts) {
      const item = history.find(h => h.prompt?.includes(prompt));
      expect(item, `prompt missing from the persisted history: ${prompt}`).toBeTruthy();
      expect(item && hasReply(item), `no persisted reply for: ${prompt}`).toBe(true);
    }
    // Only now, after the no-reload assertion, load the chat cold to show it reads back.
    await page.goto(`/notebooks/${sessionId}`);
    await expect(chatPage.aiResponseRoot.last()).toBeVisible({ timeout: TIMEOUTS.ACTION });
  });
});
