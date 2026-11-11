import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { TIMEOUTS } from './constants';
import { BasePage } from './pages/BasePage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { ModelSelectorPage } from './pages/ModelSelectorPage';
import { NavigationPage } from './pages/NavigationPage';

/**
 * Self-host browser check: a chat reply streams over the ws gateway (selfhost/ws-gateway) and the
 * same text comes back from persisted history after a reload. Run through
 * selfhost-chat-stream.config.ts against a running compose.selfhost.yaml stack that has at least
 * one model provider configured.
 *
 * Environment:
 *   SELFHOST_EMAIL        (required) account to sign in as. On a fresh install use the
 *                         B4M_BOOTSTRAP_ADMIN_EMAIL address; the check registers it on first run.
 *   SELFHOST_URL          app origin, default http://localhost:3000
 *   SELFHOST_MAILPIT_URL  Mailpit origin the sign-in code is read from, default http://localhost:8025
 *   SELFHOST_USERNAME     username used only when the account does not exist yet
 *   SELFHOST_MODEL        model card name to select; default keeps the account's current model
 *
 * Sign-in goes through the real email-code form (the code is read from Mailpit), so the browser
 * holds a refresh cookie and the reload boots the way a user's does. The chat it creates is left
 * in the account.
 */

const MAILPIT_URL = (process.env.SELFHOST_MAILPIT_URL || 'http://localhost:8025').replace(/\/$/, '');
// Mirrors OTC_CODE_LENGTH in b4m-core/services/src/userService/sendOTC.ts; keep in sync.
const OTC_CODE_PATTERN = /\b\d{8}\b/;
// Mailpit stamps `Created` from its own clock; tolerate a little drift from the runner's.
const MAIL_CLOCK_SKEW_MS = 5_000;
const SOCKET_OPEN_TIMEOUT_MS = 30_000;
const MIN_PARTIAL_FRAMES = 2;

// Long enough to span many stream frames, plain enough that the rendered text carries no markdown.
const PROMPT =
  'Write the numbers from one to one hundred as English words, in order, separated by single spaces, ' +
  'all on one line. Output only the words: no digits, no punctuation, no markdown, no commentary.';

interface StreamFrame {
  questId: string;
  reply: string;
  status?: string;
  type?: string;
}

interface SocketProbe {
  /** True once any frame crossed a socket; a socket that never opened carries none. */
  opened: boolean;
  frames: StreamFrame[];
}

/**
 * Records every `streamed_chat_completion` frame the page receives. Frames split into
 * `_chunked` envelopes (WsChunkReassembler) are not reassembled here: the prompt keeps the reply
 * far below the size that triggers chunking.
 */
function watchSockets(page: Page): SocketProbe {
  const probe: SocketProbe = { opened: false, frames: [] };
  page.on('websocket', socket => {
    socket.on('framesent', () => {
      probe.opened = true;
    });
    socket.on('framereceived', ({ payload }) => {
      probe.opened = true;
      if (typeof payload !== 'string' || !payload.startsWith('{')) return;
      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof data !== 'object' || data === null) return;
      const { action, quest } = data as { action?: unknown; quest?: Record<string, unknown> };
      if (action !== 'streamed_chat_completion' || !quest || typeof quest.id !== 'string') return;
      probe.frames.push({
        questId: quest.id,
        reply: typeof quest.reply === 'string' ? quest.reply : '',
        status: typeof quest.status === 'string' ? quest.status : undefined,
        type: typeof quest.type === 'string' ? quest.type : undefined,
      });
    });
  });
  return probe;
}

async function readSignInCode(request: APIRequestContext, email: string, sentAfter: number): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT_URL}/api/v1/search`, {
          params: { query: `to:"${email}"`, limit: '5' },
        });
        if (!search.ok()) return '';
        const { messages = [] } = (await search.json()) as { messages?: { ID: string; Created: string }[] };
        const fresh = messages.find(m => Date.parse(m.Created) >= sentAfter - MAIL_CLOCK_SKEW_MS);
        if (!fresh) return '';
        const message = await request.get(`${MAILPIT_URL}/api/v1/message/${fresh.ID}`);
        if (!message.ok()) return '';
        const { Text = '' } = (await message.json()) as { Text?: string };
        code = Text.match(OTC_CODE_PATTERN)?.[0] ?? '';
        return code;
      },
      { timeout: TIMEOUTS.ACTION, message: `no sign-in code for ${email} arrived in Mailpit at ${MAILPIT_URL}` }
    )
    .not.toBe('');
  return code;
}

async function signIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const login = new LoginPage(page);
  const sentAfter = Date.now();
  await login.goto();
  await login.fillEmail(email);
  await login.fillOtc(await readSignInCode(request, email, sentAfter));
  await login.submitExpectingInlineRegister();

  // A known account is routed into the app; an unknown email gets the inline register step.
  const registerInput = page.getByTestId('login-register-username-input');
  await expect
    .poll(async () => !page.url().includes('/login') || (await registerInput.isVisible()), {
      timeout: TIMEOUTS.ACTION,
      message: 'sign-in neither completed nor reached the register step',
    })
    .toBe(true);
  if (!page.url().includes('/login')) return;

  const fallbackUsername = `${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '')}${Date.now() % 10_000}`;
  await login.fillInlineRegisterUsername(process.env.SELFHOST_USERNAME || fallbackUsername);
  await login.acceptInlineRegisterPolicies();
  await login.submitInlineRegister();
}

/** Rendered answer text of the newest reply, or '' before its first token. */
async function newestAnswerText(page: Page): Promise<string> {
  const answer = page.getByTestId('ai-response-root-container').last().getByTestId('ai-response-markdown');
  if ((await answer.count()) === 0) return '';
  return answer
    .first()
    .innerText({ timeout: TIMEOUTS.ELEMENT_STATE })
    .catch(() => '');
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

test('a chat reply streams over the WebSocket and survives a reload', async ({ page, request }) => {
  const email = process.env.SELFHOST_EMAIL;
  if (!email) throw new Error('SELFHOST_EMAIL must be set (see the header of selfhost-chat-stream.spec.ts)');

  const probe = watchSockets(page);
  const basePage = new BasePage(page);
  const chat = new ChatPage(page);

  await test.step('sign in with the emailed code', async () => {
    await signIn(page, request, email.toLowerCase().trim());
    await basePage.dismissModals();
  });

  await test.step('open a live socket', async () => {
    // Soft: with the gateway down the stream assertions below are the failure worth reading.
    const opened = await expect
      .poll(() => probe.opened, { timeout: SOCKET_OPEN_TIMEOUT_MS })
      .toBe(true)
      .then(
        () => true,
        () => false
      );
    expect
      .soft(opened, 'the browser never exchanged a frame with the ws gateway (check WEBSOCKET_URL and the ws service)')
      .toBe(true);
  });

  await test.step('start a new chat', async () => {
    await new NavigationPage(page).navigateToNewChat();
    if (process.env.SELFHOST_MODEL) {
      await new ModelSelectorPage(page).selectTextModel(process.env.SELFHOST_MODEL, { disableSmartTools: true });
    }
  });

  const framesBeforeSend = probe.frames.length;
  const renderedWhileStreaming = new Set<string>();
  let streamedText = '';

  await test.step('send a prompt and watch the reply stream', async () => {
    let sampling = true;
    const sampler = (async () => {
      while (sampling && !page.isClosed()) {
        const text = collapseWhitespace(await newestAnswerText(page));
        if (text) renderedWhileStreaming.add(text);
        await page.waitForTimeout(100);
      }
    })();
    try {
      streamedText = await chat.sendMessageAndWaitForResponse(PROMPT, TIMEOUTS.AI_RESPONSE);
    } finally {
      sampling = false;
      await sampler;
    }
    expect(collapseWhitespace(streamedText), 'the reply finished with no text').not.toBe('');
  });

  await test.step('incremental frames arrived before completion', async () => {
    const sent = probe.frames.slice(framesBeforeSend);
    expect(
      sent.length,
      'no streamed_chat_completion frame reached the browser: the reply did not stream over the WebSocket'
    ).toBeGreaterThan(0);

    const questId = sent[0].questId;
    // The terminal frame can trail the stop button hiding by a beat.
    await expect
      .poll(() => probe.frames.some(f => f.questId === questId && f.status === 'done'), {
        timeout: TIMEOUTS.VISIBLE,
        message: 'the stream never delivered a frame with status "done"',
      })
      .toBe(true);

    const frames = probe.frames.slice(framesBeforeSend).filter(f => f.questId === questId);
    expect(
      frames.filter(f => f.type === 'error').map(f => f.reply),
      'the model call failed'
    ).toEqual([]);

    const doneIndex = frames.findIndex(f => f.status === 'done');
    const finalLength = frames[doneIndex].reply.length;
    const partialLengths: number[] = [];
    for (const frame of frames.slice(0, doneIndex)) {
      const length = frame.reply.length;
      if (length > 0 && length < finalLength && length > (partialLengths.at(-1) ?? 0)) partialLengths.push(length);
    }
    expect(
      partialLengths.length,
      `expected at least ${MIN_PARTIAL_FRAMES} growing partial replies before the "done" frame, saw lengths [${partialLengths.join(', ')}] of ${finalLength}`
    ).toBeGreaterThanOrEqual(MIN_PARTIAL_FRAMES);

    // The page itself showed a partial reply, so what it rendered came from those frames and not
    // from a fetch after completion.
    const finalRendered = collapseWhitespace(streamedText);
    expect(
      [...renderedWhileStreaming].some(text => text.length < finalRendered.length && finalRendered.startsWith(text)),
      'the page never rendered a partial reply while the stream was in flight'
    ).toBe(true);
  });

  await test.step('the reloaded history shows the same reply', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await basePage.dismissModals();
    await expect
      .poll(async () => collapseWhitespace(await newestAnswerText(page)), {
        timeout: TIMEOUTS.ACTION,
        message: 'the reloaded chat history does not show the streamed reply',
      })
      .toBe(collapseWhitespace(streamedText));
  });
});
