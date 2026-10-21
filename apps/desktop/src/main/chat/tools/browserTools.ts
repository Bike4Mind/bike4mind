import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import { isLocalUrl, normalizeUrl } from '@shared/browserUrl';
import type { ScrollTarget } from '../browser/pageScripts';
import type { ApprovalPrompt, BrowserContext, BrowserPage, BrowserTabInfo, ToolContext, ToolDefinition } from './types';
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

const STOPPED = 'Stopped: the turn was interrupted before this browser step finished.';

/**
 * Run one tool's steps on the session's active tab, or on `tab` when the tool just opened one
 * (the user may have switched away from it since), ending them at a stop.
 *
 * The stop also halts whatever the page is loading, so Chromium is not left fetching for a turn
 * that has moved on - and since Electron holds page scripts until a load ends, that is also what
 * frees a step still waiting inside. The page's own deadlines live in BrowserManager.
 */
async function onPage<T>(
  context: ToolContext,
  steps: (page: BrowserPage) => Promise<T>,
  tab?: BrowserPage
): Promise<T> {
  const page = tab ?? (await requireBrowser(context).page());
  const { signal } = context;
  if (signal.aborted) throw new Error(STOPPED);
  let onAbort: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      page.stop();
      reject(new Error(STOPPED));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([steps(page), stopped]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Acting on whatever page is open is free on a local dev server and asked per origin elsewhere. */
async function actsOnLocalPage(context: ToolContext): Promise<boolean> {
  const current = (await requireBrowser(context).page()).currentUrl();
  return !current || isLocalUrl(current);
}

/**
 * Whether the page carries cookies the USER imported from their own Chrome.
 *
 * Reaching a site as the signed-in person is not the act that 'auto' and 'full' are a decision
 * about, so everything that touches such a page is asked about in every mode and keyed apart
 * from the same action on the same origin anonymously. See cookies/CookieImporter: a tool can
 * only read this flag, never set one.
 */
function onUserSession(context: ToolContext, url: string): boolean {
  return !!url && (context.browser?.usesImportedCookies(url) ?? false);
}

/** Added to an approval the user has to answer themselves, whatever mode they set. */
const AS_THE_USER = { askInAuto: true, askInFull: true } as const;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Shared by browser_navigate, browser_snapshot, browser_screenshot and a tab switch: one "always" covers all. */
function readAsYouApproval(url: string, verb: string): ApprovalPrompt {
  return {
    detail: `${verb} ${url} as your signed-in ${new URL(url).hostname} session`,
    key: `browser-open-as-you:${new URL(url).origin}`,
    ...AS_THE_USER,
  };
}

/**
 * Whether the model may be shown what is on `url`. A site carrying the user's imported cookies
 * needs consent for that very origin: the approval this call ran under, or a standing one.
 *
 * Checked on where the page IS when it is read, never on what was typed: a redirect, a link, a
 * script setting location.href, history and a tab the user opened all reach a page no approval
 * named. Not a navigation gate on the view, because the user browses this pane by hand too and
 * nothing there can tell their click from the agent's.
 */
function mayRead(context: ToolContext, url: string): boolean {
  if (!onUserSession(context, url)) return true;
  const origin = originOf(url);
  if (!origin) return false;
  const consented = [`browser-open-as-you:${origin}`, `browser-act-as-you:${origin}`, `browser-script:${origin}`];
  if (context.approvedKey && consented.includes(context.approvedKey)) return true;
  return consented.some(key => context.isStanding?.(key) ?? false);
}

/** Drains the page's events too: they came from the page being withheld. */
function withheld(page: BrowserPage, lead: string, url: string): string {
  page.drainEvents();
  return (
    `${lead}\nThe page is now on ${originOf(url)}, a site the user is signed in to with cookies imported ` +
    "from their own browser, so its content is not shown without the user's say-so. Call " +
    'browser_snapshot to read it, which asks them.'
  );
}

/**
 * A cross-origin frame is opaque to the snapshot but not to capturePage, and imported cookies keep
 * SameSite=None, so a page the agent wrote can frame a signed-in site and screenshot it as the user.
 */
function unreadableFrame(context: ToolContext, page: BrowserPage): string | undefined {
  return page.frameUrls().find(url => !mayRead(context, url));
}

function withheldFrame(page: BrowserPage, url: string): string {
  page.drainEvents();
  const origin = originOf(url);
  return (
    `Took no screenshot.\nThe page embeds ${origin}, a site the user is signed in to with cookies imported ` +
    "from their own browser, so a screenshot showing it is not taken without the user's say-so. To ask " +
    `them, call browser_navigate on ${origin}; if they allow it always, a page embedding it can be captured.`
  );
}

/** Reading the open page as the signed-in user is asked about as opening it would have been. */
const gatedRead: Pick<ToolDefinition, 'needsApproval' | 'approval'> = {
  needsApproval: async (_input, context) => onUserSession(context, (await requireBrowser(context).page()).currentUrl()),
  approval: async (_input, context) => readAsYouApproval((await requireBrowser(context).page()).currentUrl(), 'Read'),
};

async function actionApproval(
  verb: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ApprovalPrompt> {
  const current = (await requireBrowser(context).page()).currentUrl();
  const origin = new URL(current).origin;
  const target = typeof input.ref === 'string' ? ` (element ${input.ref})` : '';
  if (onUserSession(context, current)) {
    return {
      detail: `${verb} on ${origin}${target}, signed in as you`,
      key: `browser-act-as-you:${origin}`,
      ...AS_THE_USER,
    };
  }
  return { detail: `${verb} on ${origin}${target}`, key: `browser-act:${origin}` };
}

/** True for a page that is neither a local dev server nor carrying the user's own session. */
async function actionNeedsApproval(context: ToolContext): Promise<boolean> {
  if (!(await actsOnLocalPage(context))) return true;
  return onUserSession(context, (await requireBrowser(context).page()).currentUrl());
}

const gatedAction = (verb: string): Pick<ToolDefinition, 'needsApproval' | 'approval'> => ({
  needsApproval: (_input, context) => actionNeedsApproval(context),
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
  needsApproval: (_input, context) => actionNeedsApproval(context),
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

async function describePage(
  context: ToolContext,
  page: BrowserPage,
  maxChars: number,
  lead: string,
  inView = false
): Promise<string> {
  await page.settle(SETTLE_MS);
  const snap = inView ? await page.snapshot(maxChars, true) : await page.snapshot(maxChars);
  if (!mayRead(context, snap.url)) return withheld(page, lead, snap.url);
  const header = `${lead}\nPage: ${snap.title || '(untitled)'} - ${snap.url}`;
  const note = snap.truncated
    ? '\n[Snapshot cut at the size limit. Use browser_evaluate to read a specific part of the page.]'
    : '';
  return capOutput(`${header}\n\n${snap.text || '(no visible text)'}${note}${eventsSection(page)}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Load `url` into `tab` (the active tab when absent) and describe what arrived. */
async function loadAndDescribe(context: ToolContext, url: string, label: string, tab?: BrowserPage): Promise<string> {
  return onPage(
    context,
    async page => {
      context.report?.label(label);
      const loaded = await page.navigate(url);
      const status = loaded.status ? ` (HTTP ${loaded.status})` : '';
      // A redirect's target can carry a token in its path, so only its origin is named until it may be read.
      const where = mayRead(context, loaded.url) ? loaded.url : originOf(loaded.url);
      const lead = loaded.stillLoading
        ? `Loaded ${where}${status}, but it was still loading at the time limit, so loading was stopped ` +
          'there. Parts of the page may be missing.'
        : `Loaded ${where}${status}.`;
      return describePage(context, page, SNAPSHOT_CHARS, lead);
    },
    tab
  );
}

const AT_TAB_CAP = `This conversation already has ${MAX_BROWSER_TABS} tabs open, the most it may.`;

export const browserNavigate: ToolDefinition = {
  schema: {
    name: 'browser_navigate',
    description:
      "Open a URL in this conversation's browser - a real Chromium window with its own cookies, " +
      "separate from the user's browser - and return a text snapshot of the page. Interactive " +
      'elements appear as [ref] lines; pass a ref to browser_click or browser_type. Local dev ' +
      'servers (localhost, 127.0.0.1) open without asking. Opens in the active tab unless new_tab is set.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to open, e.g. http://localhost:3000/login.' },
        new_tab: {
          type: 'boolean',
          description: 'Open it in a new tab, which becomes the active one, keeping the current page open.',
        },
      },
      required: ['url'],
    },
  },
  needsApproval: (input, context) => {
    const url = normalizeUrl(requireString(input, 'url'));
    return !isLocalUrl(url) || onUserSession(context, url);
  },
  approval(input, context) {
    const url = normalizeUrl(requireString(input, 'url'));
    if (onUserSession(context, url)) return readAsYouApproval(url, 'Open');
    return { detail: `Open ${url}`, key: `browser-open:${new URL(url).origin}` };
  },
  async run(input, context) {
    const url = normalizeUrl(requireString(input, 'url'));
    if (input.new_tab !== true) return loadAndDescribe(context, url, `Opened ${url}`);
    const tab = await requireBrowser(context).newTab();
    if (tab) return loadAndDescribe(context, url, `Opened tab: ${hostOf(url)}`, tab);
    const result = await loadAndDescribe(context, url, `Opened ${url}`);
    return `${AT_TAB_CAP} It opened in the active tab instead; close a tab with browser_tabs to open more.\n${result}`;
  },
};

const TAB_ACTIONS = ['list', 'new', 'select', 'close'] as const;
type TabAction = (typeof TAB_ACTIONS)[number];

function tabAction(input: Record<string, unknown>): TabAction {
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
  if (!TAB_ACTIONS.includes(action as TabAction)) throw new Error(`"action" must be one of ${TAB_ACTIONS.join(', ')}.`);
  return action as TabAction;
}

function tabId(input: Record<string, unknown>): number {
  const raw = typeof input.id === 'string' ? input.id.trim() : input.id;
  const id = typeof raw === 'string' && raw !== '' ? Number(raw) : raw;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required: the tab id from browser_tabs with action "list".');
  }
  return id;
}

/** A url for `new`, or '' for a blank tab. Resolved the way browser_navigate resolves one. */
function newTabUrl(input: Record<string, unknown>): string {
  return typeof input.url === 'string' && input.url.trim() ? normalizeUrl(input.url) : '';
}

/** '' for an id that is not open, which `selectTab` then refuses. */
function selectedTabUrl(input: Record<string, unknown>, context: ToolContext): string {
  const id = tabId(input);
  return (
    requireBrowser(context)
      .tabs()
      .find(tab => tab.id === id)?.url ?? ''
  );
}

const tabName = (tab: BrowserTabInfo) => tab.title || (tab.url ? hostOf(tab.url) : 'New tab');

/** A signed-in tab's title and path are its content too: an inbox title carries the address and unread count. */
function listTabs(context: ToolContext, tabs: readonly BrowserTabInfo[]): string {
  if (tabs.length === 0) return 'No tabs are open. browser_navigate or browser_tabs with action "new" opens one.';
  const lines = tabs.map(tab => {
    const shown = mayRead(context, tab.url)
      ? `${tab.title || '(untitled)'} - ${tab.url || '(no page yet)'}`
      : `(signed in as the user; select it to read it, which asks them) - ${originOf(tab.url)}`;
    return `- tab ${tab.id}${tab.active ? ' (active)' : ''}: ${shown}`;
  });
  return `${tabs.length} of at most ${MAX_BROWSER_TABS} tabs open:\n${lines.join('\n')}`;
}

/**
 * One tool for the tab strip rather than four. Tabs are a side concern of browsing - most turns
 * never touch them - and every declared tool's schema is paid for in every request.
 */
export const browserTabs: ToolDefinition = {
  schema: {
    name: 'browser_tabs',
    description:
      "Manage the browser's tabs. Every other browser tool acts on the active tab, which the user's " +
      'pane shows too. Actions: list (each tab with its id, title, url and whether it is active); ' +
      'new (opens a tab and makes it active; with url, loads it and returns its snapshot); select ' +
      '(makes the tab with this id active and returns its snapshot); close (closes the tab with this id).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...TAB_ACTIONS], description: 'What to do.' },
        id: { type: 'number', description: 'The tab id, for select and close.' },
        url: { type: 'string', description: 'For new: the page to open in it. Leave out for a blank tab.' },
      },
      required: ['action'],
    },
  },
  needsApproval(input, context) {
    const action = tabAction(input);
    if (action === 'select') return onUserSession(context, selectedTabUrl(input, context));
    if (action !== 'new' || !newTabUrl(input)) return false;
    return browserNavigate.needsApproval!({ url: newTabUrl(input) }, context);
  },
  approval(input, context) {
    if (tabAction(input) === 'select') return readAsYouApproval(selectedTabUrl(input, context), 'Switch to');
    return browserNavigate.approval!({ url: newTabUrl(input) }, context);
  },
  async run(input, context) {
    const browser = requireBrowser(context);
    const action = tabAction(input);
    if (action === 'list') {
      context.report?.label('Listed tabs');
      return listTabs(context, browser.tabs());
    }
    if (action === 'new') {
      const url = newTabUrl(input);
      const tab = await browser.newTab();
      if (!tab) throw new Error(`${AT_TAB_CAP} Close one with browser_tabs before opening another.`);
      if (url) return loadAndDescribe(context, url, `Opened tab: ${hostOf(url)}`, tab);
      context.report?.label('Opened a new tab');
      return `Opened a blank tab, which is now the active one.\n\n${listTabs(context, browser.tabs())}`;
    }
    const id = tabId(input);
    if (action === 'close') {
      const closed = await browser.closeTab(id);
      context.report?.label(`Closed tab: ${tabName(closed)}`);
      return `Closed tab ${id}.\n\n${listTabs(context, browser.tabs())}`;
    }
    const selected = await browser.selectTab(id);
    context.report?.label(`Switched to tab: ${tabName(selected)}`);
    if (!selected.url) return `Switched to tab ${id}, which has no page yet.`;
    return onPage(context, page => describePage(context, page, SNAPSHOT_CHARS, `Switched to tab ${id}.`));
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
  ...gatedRead,
  async run(_input, context) {
    return onPage(context, async page => {
      if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
      return describePage(context, page, SNAPSHOT_CHARS, 'Current page.');
    });
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
    return onPage(context, async page => {
      const clicked = await page.click(ref);
      context.report?.label(`Clicked ${clicked}`);
      return describePage(context, page, ACTION_SNAPSHOT_CHARS, `Clicked [${ref}] ${clicked}.`);
    });
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
    return onPage(context, async page => {
      const filled = await page.fill(ref, text);
      if (input.submit === true) await page.press('Enter');
      context.report?.label(`Typed into [${ref}]`);
      return describePage(
        context,
        page,
        ACTION_SNAPSHOT_CHARS,
        `[${ref}] ${filled}${input.submit === true ? ', then pressed Enter' : ''}.`
      );
    });
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
    return onPage(context, async page => {
      await page.press(key);
      return describePage(context, page, ACTION_SNAPSHOT_CHARS, `Pressed ${key}.`);
    });
  },
};

const SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

function scrollTarget(input: Record<string, unknown>): ScrollTarget {
  const rawRef = typeof input.ref === 'number' ? String(input.ref) : typeof input.ref === 'string' ? input.ref : '';
  const ref = rawRef.trim().replace(/^\[|\]$/g, '');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const direction = typeof input.direction === 'string' ? input.direction.trim().toLowerCase() : '';
  if ([ref, text, direction].filter(Boolean).length !== 1) {
    throw new Error('Pass exactly one of "ref", "text" or "direction".');
  }
  if (ref) {
    // Snapshot refs are numbers; anything else would also break the attribute selector it goes into.
    if (!/^\d+$/.test(ref)) throw new Error(`No element matched ref ${ref}; take a browser_snapshot for current refs.`);
    return { ref };
  }
  if (text) return { text };
  if (!SCROLL_DIRECTIONS.includes(direction as ScrollDirection)) {
    throw new Error(`"direction" must be one of ${SCROLL_DIRECTIONS.join(', ')}.`);
  }
  const target: ScrollTarget = { direction: direction as ScrollDirection };
  if (input.amount === undefined || input.amount === null) return target;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('"amount" must be a positive number.');
  return input.unit === 'pixels'
    ? { ...target, pixels: Math.max(1, Math.round(amount)) }
    : { ...target, pages: amount };
}

export const browserScroll: ToolDefinition = {
  schema: {
    name: 'browser_scroll',
    description:
      'Scroll the open page and return a snapshot of what is now in view. Pass exactly one of: ref ' +
      '(an element from the latest snapshot, brought to the middle of the view), text (the first ' +
      'visible element containing it), or direction. A direction scrolls the page, or the panel ' +
      'under the middle of the view when the app scrolls an inner panel instead. Use this rather ' +
      'than browser_evaluate to scroll.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The element ref from the latest snapshot, e.g. "12".' },
        text: { type: 'string', description: 'Text to find on the page, case-insensitive.' },
        direction: { type: 'string', enum: [...SCROLL_DIRECTIONS], description: 'Which way to scroll.' },
        amount: {
          type: 'number',
          description: 'How far to scroll up or down, in units. Defaults to about one screen.',
        },
        unit: { type: 'string', enum: ['pages', 'pixels'], description: 'The unit of amount. Defaults to pages.' },
      },
    },
  },
  ...gatedAction('Scroll'),
  async run(input, context) {
    const target = scrollTarget(input);
    return onPage(context, async page => {
      if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
      const outcome = await page.scroll(target);
      let lead: string;
      if ('ref' in target) {
        context.report?.label(`Scrolled to ${outcome}`);
        lead = `Scrolled [${target.ref}] ${outcome} into view.`;
      } else if ('text' in target) {
        context.report?.label(`Scrolled to ${target.text}`);
        lead = `Scrolled to the first element containing ${JSON.stringify(target.text)}: ${outcome}.`;
      } else {
        const { direction } = target;
        context.report?.label(
          direction === 'top' || direction === 'bottom' ? `Scrolled to the ${direction}` : `Scrolled ${direction}`
        );
        lead = outcome;
      }
      return describePage(context, page, ACTION_SNAPSHOT_CHARS, `${lead} What is in view now:`, true);
    });
  },
};

export const browserBack: ToolDefinition = {
  schema: {
    name: 'browser_back',
    description: 'Go back one page in history and return the snapshot.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_input, context) {
    return onPage(context, async page => {
      await page.back();
      return describePage(context, page, ACTION_SNAPSHOT_CHARS, 'Went back.');
    });
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
  ...gatedRead,
  async run(input, context) {
    const browser = requireBrowser(context);
    return onPage(context, async page => {
      if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
      await page.settle(SETTLE_MS);
      const before = page.currentUrl();
      const framedBefore = unreadableFrame(context, page);
      const bytes = await page.screenshot();
      const url = page.currentUrl();
      if (!mayRead(context, before)) return withheld(page, 'Took no screenshot.', before);
      if (!mayRead(context, url)) return withheld(page, 'Took no screenshot.', url);
      const framed = framedBefore ?? unreadableFrame(context, page);
      if (framed) return withheldFrame(page, framed);
      const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : url;
      const kept = await browser.keepScreenshot(bytes, caption);
      if (kept) context.report?.media(kept);
      context.report?.image(bytes, 'image/png');
      return `Captured a screenshot of ${url}. It is attached below this result.`;
    });
  },
};

const NULL_DEREFERENCE = /Cannot (read|set) propert(y|ies) of (null|undefined)/;

/** The usual cause is a querySelector that matched nothing; say so, keeping the page's own message. */
function withNullHint(error: unknown): unknown {
  if (!(error instanceof Error) || !NULL_DEREFERENCE.test(error.message)) return error;
  return new Error(
    `${error.message}\nHint: a selector probably matched nothing. Use optional chaining (el?.prop), or take ` +
      'browser_snapshot refs and use browser_click / browser_scroll instead.'
  );
}

export const browserEvaluate: ToolDefinition = {
  schema: {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the open page and return its JSON result, e.g. ' +
      "document.querySelector('h1')?.innerText or await fetch('/api/me').then(r => r.json()). " +
      "Runs with the page's own cookies and origin, so it can call the app's API as the signed-in user. " +
      'Use it to read data and call APIs; to interact, use browser_click, browser_type and browser_scroll ' +
      'with refs from the snapshot.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'An expression; await is allowed.' } },
      required: ['expression'],
    },
  },
  ...gatedScript,
  async run(input, context) {
    const expression = requireString(input, 'expression');
    return onPage(context, async page => {
      if (!page.currentUrl()) throw new Error('No page is open yet. Call browser_navigate first.');
      const value = await page.evaluate(expression).catch((error: unknown) => {
        throw withNullHint(error);
      });
      const rendered = value === undefined ? 'undefined' : JSON.stringify(value, null, 1);
      // The value was computed in the origin the gate judged; only what the page did after can be elsewhere.
      const after = page.currentUrl();
      const events = mayRead(context, after) ? eventsSection(page) : `\n\n${withheld(page, '', after).trim()}`;
      return capOutput(`${rendered ?? String(value)}${events}`);
    });
  },
};

export const BROWSER_TOOLS: readonly ToolDefinition[] = [
  browserNavigate,
  browserTabs,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserBack,
  browserScreenshot,
  browserEvaluate,
];
