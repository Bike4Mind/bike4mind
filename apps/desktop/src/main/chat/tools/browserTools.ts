import { isLocalUrl, normalizeUrl } from '@shared/browserUrl';
import type { ApprovalPrompt, BrowserContext, BrowserPage, ToolContext, ToolDefinition } from './types';
import { capOutput, requireString } from './types';

export { isLocalUrl, normalizeUrl };

/** A snapshot asked for outright. Action results carry a smaller one, since they come every step. */
export const SNAPSHOT_CHARS = 20_000;
export const ACTION_SNAPSHOT_CHARS = 12_000;
/** How long an action waits for the page to go quiet before describing it. */
const SETTLE_MS = 5_000;
const MAX_EVENT_LINES = 25;

function requireBrowser(context: ToolContext): BrowserContext {
  if (!context.browser) throw new Error('The browser is not available in this session.');
  return context.browser;
}

/** Acting on whatever page is open is free on a local dev server and asked per origin elsewhere. */
async function actsOnLocalPage(context: ToolContext): Promise<boolean> {
  const current = (await requireBrowser(context).page()).currentUrl();
  return !current || isLocalUrl(current);
}

async function actionApproval(
  verb: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ApprovalPrompt> {
  const origin = new URL((await requireBrowser(context).page()).currentUrl()).origin;
  const target = typeof input.ref === 'string' ? ` (element ${input.ref})` : '';
  return { detail: `${verb} on ${origin}${target}`, key: `browser-act:${origin}` };
}

const gatedAction = (verb: string): Pick<ToolDefinition, 'needsApproval' | 'approval'> => ({
  needsApproval: async (_input, context) => !(await actsOnLocalPage(context)),
  approval: (input, context) => actionApproval(verb, input, context),
});

/**
 * Running a script on a page that is not the user's own dev server, which is asked about in
 * EVERY mode - 'full' included.
 *
 * The browser's cookie jar used to hold nothing but dev-server logins the agent had created
 * itself, and on that reading an ungated `browser_evaluate` was a script running against the
 * agent's own work. The pane's url bar ends that reading: the user can browse anywhere and sign
 * in by hand, in this jar, and a script in that page reads `document.cookie` and calls the
 * site's API as them - with the result going into the model's context and so to the provider.
 *
 * Keyed apart from the other actions on purpose. Clicking a button on a site is a thing the user
 * can see the shape of; "always allow" for that must not quietly also mean "and run whatever
 * JavaScript you like there".
 *
 * Gated on the origin the script would RUN in, rather than on whether this page has ever left a
 * local origin. Navigating back to localhost is not a way around it: a script in a localhost
 * page is in localhost's origin, so the same-origin policy is what stops it reading the other
 * site's cookies or responses, not this check. A sticky rule would ask about every later
 * `document.querySelector` on the dev server the agent is there to test, which is the kind of
 * friction that gets a gate switched off wholesale.
 */
const gatedScript: Pick<ToolDefinition, 'needsApproval' | 'approval'> = {
  needsApproval: async (_input, context) => !(await actsOnLocalPage(context)),
  async approval(_input, context) {
    const origin = new URL((await requireBrowser(context).page()).currentUrl()).origin;
    return {
      detail: `Run a script on ${origin}, with that site's cookies`,
      key: `browser-script:${origin}`,
      askInAuto: true,
      askInFull: true,
    };
  },
};

function eventsSection(page: BrowserPage): string {
  const events = page.drainEvents();
  if (events.length === 0) return '';
  const shown = events.slice(-MAX_EVENT_LINES);
  const skipped = events.length - shown.length;
  return `\n\nSince the last step:${skipped > 0 ? ` (${skipped} earlier omitted)` : ''}\n${shown.map(line => `- ${line}`).join('\n')}`;
}

async function describePage(page: BrowserPage, maxChars: number, lead: string): Promise<string> {
  await page.settle(SETTLE_MS);
  const snap = await page.snapshot(maxChars);
  const header = `${lead}\nPage: ${snap.title || '(untitled)'} - ${snap.url}`;
  const note = snap.truncated
    ? '\n[Snapshot cut at the size limit. Use browser_evaluate to read a specific part of the page.]'
    : '';
  return capOutput(`${header}\n\n${snap.text || '(no visible text)'}${note}${eventsSection(page)}`);
}

export const browserNavigate: ToolDefinition = {
  schema: {
    name: 'browser_navigate',
    description:
      "Open a URL in this conversation's browser - a real Chromium window with its own cookies, " +
      "separate from the user's browser - and return a text snapshot of the page. Interactive " +
      'elements appear as [ref] lines; pass a ref to browser_click or browser_type. Local dev ' +
      'servers (localhost, 127.0.0.1) open without asking.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to open, e.g. http://localhost:3000/login.' },
      },
      required: ['url'],
    },
  },
  needsApproval: input => !isLocalUrl(normalizeUrl(requireString(input, 'url'))),
  approval(input) {
    const url = normalizeUrl(requireString(input, 'url'));
    const origin = new URL(url).origin;
    return { detail: `Open ${url}`, key: `browser-open:${origin}` };
  },
  async run(input, context) {
    const url = normalizeUrl(requireString(input, 'url'));
    const page = await requireBrowser(context).page();
    context.report?.label(`Opened ${url}`);
    const loaded = await page.navigate(url);
    const status = loaded.status ? ` (HTTP ${loaded.status})` : '';
    return describePage(page, SNAPSHOT_CHARS, `Loaded ${loaded.url}${status}.`);
  },
};

export const browserSnapshot: ToolDefinition = {
  schema: {
    name: 'browser_snapshot',
    description:
      'Read the open page again as text, with [ref] numbers on interactive elements. Actions ' +
      'already return a fresh snapshot, so only call this after waiting on something slow.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_input, context) {
    const page = await requireBrowser(context).page();
    if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
    return describePage(page, SNAPSHOT_CHARS, 'Current page.');
  },
};

export const browserClick: ToolDefinition = {
  schema: {
    name: 'browser_click',
    description:
      'Click an element by its [ref] from the latest snapshot, wait for the page to settle, and ' +
      'return the new snapshot plus any console errors or failed requests it caused.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'The element ref, e.g. "12".' } },
      required: ['ref'],
    },
  },
  ...gatedAction('Click'),
  async run(input, context) {
    const ref = String(input.ref ?? '').replace(/^\[|\]$/g, '');
    if (!ref) throw new Error('The "ref" argument is required.');
    const page = await requireBrowser(context).page();
    const clicked = await page.click(ref);
    context.report?.label(`Clicked ${clicked}`);
    return describePage(page, ACTION_SNAPSHOT_CHARS, `Clicked [${ref}] ${clicked}.`);
  },
};

export const browserType: ToolDefinition = {
  schema: {
    name: 'browser_type',
    description:
      'Fill an input, textarea or select (by [ref]) with text, replacing what is there; for a ' +
      'select, pass the option text. Set submit to press Enter afterwards. Returns the new snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The element ref from the latest snapshot.' },
        text: { type: 'string', description: 'What to enter.' },
        submit: { type: 'boolean', description: 'Press Enter after filling, e.g. to submit a form.' },
      },
      required: ['ref', 'text'],
    },
  },
  ...gatedAction('Type'),
  async run(input, context) {
    const ref = String(input.ref ?? '').replace(/^\[|\]$/g, '');
    if (!ref) throw new Error('The "ref" argument is required.');
    const text = typeof input.text === 'string' ? input.text : String(input.text ?? '');
    const page = await requireBrowser(context).page();
    const filled = await page.fill(ref, text);
    if (input.submit === true) await page.press('Enter');
    context.report?.label(`Typed into [${ref}]`);
    return describePage(
      page,
      ACTION_SNAPSHOT_CHARS,
      `[${ref}] ${filled}${input.submit === true ? ', then pressed Enter' : ''}.`
    );
  },
};

export const browserPress: ToolDefinition = {
  schema: {
    name: 'browser_press',
    description:
      'Press a key on the focused element - Enter, Tab, Escape, ArrowDown and so on. Returns the new snapshot.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The key name.' } },
      required: ['key'],
    },
  },
  ...gatedAction('Press a key'),
  async run(input, context) {
    const key = requireString(input, 'key');
    const page = await requireBrowser(context).page();
    await page.press(key);
    return describePage(page, ACTION_SNAPSHOT_CHARS, `Pressed ${key}.`);
  },
};

export const browserBack: ToolDefinition = {
  schema: {
    name: 'browser_back',
    description: 'Go back one page in history and return the snapshot.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_input, context) {
    const page = await requireBrowser(context).page();
    await page.back();
    return describePage(page, ACTION_SNAPSHOT_CHARS, 'Went back.');
  },
};

export const browserScreenshot: ToolDefinition = {
  schema: {
    name: 'browser_screenshot',
    description:
      'Capture the visible page as an image. You see the image (when the model accepts images) ' +
      'and so does the user, in the conversation. Use it to check layout and visual state; the ' +
      'text snapshot is cheaper for reading content.',
    parameters: {
      type: 'object',
      properties: { caption: { type: 'string', description: 'What this screenshot shows, for the user.' } },
    },
  },
  async run(input, context) {
    const browser = requireBrowser(context);
    const page = await browser.page();
    const url = page.currentUrl();
    if (!url) throw new Error('No page is open yet. Call browser_navigate first.');
    await page.settle(SETTLE_MS);
    const bytes = await page.screenshot();
    const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : url;
    const kept = await browser.keepScreenshot(bytes, caption);
    if (kept) context.report?.media(kept);
    context.report?.image(bytes, 'image/png');
    return `Captured a screenshot of ${url}. It is attached below this result.`;
  },
};

export const browserEvaluate: ToolDefinition = {
  schema: {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the open page and return its JSON result, e.g. ' +
      "document.querySelector('h1').innerText or await fetch('/api/me').then(r => r.json()). " +
      "Runs with the page's own cookies and origin, so it can call the app's API as the signed-in user.",
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'An expression; await is allowed.' } },
      required: ['expression'],
    },
  },
  ...gatedScript,
  async run(input, context) {
    const expression = requireString(input, 'expression');
    const page = await requireBrowser(context).page();
    if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
    const value = await page.evaluate(expression);
    const rendered = value === undefined ? 'undefined' : JSON.stringify(value, null, 1);
    return capOutput(`${rendered ?? String(value)}${eventsSection(page)}`);
  },
};

export const BROWSER_TOOLS: readonly ToolDefinition[] = [
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  browserBack,
  browserScreenshot,
  browserEvaluate,
];
