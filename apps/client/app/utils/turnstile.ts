const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CHALLENGE_TIMEOUT_MS = 60_000;
/** Widget errors are often transient (network blips, a flaky challenge), so a few fresh renders run first. */
export const MAX_CHALLENGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_500;
/**
 * Site configuration and browser errors (bad site key, domain not allowed, unsupported browser, wrong clock):
 * retrying cannot help. 1106xx challenge timeouts are retryable, per Cloudflare's client-side error code table.
 */
const NON_RETRYABLE_ERROR_CODE = /^(1101|1102|1104|1105|200100|400)/;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: 'interaction-only';
      theme: 'light' | 'dark';
      size: 'normal' | 'compact';
      retry: 'never';
      'before-interactive-callback': () => void;
      callback: (token: string) => void;
      'error-callback': (errorCode?: string) => boolean;
      'expired-callback': () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type TurnstileFailureReason =
  'script-error' | 'script-timeout' | 'unavailable' | 'error' | 'expired' | 'timeout' | 'render-failed';

/** Why the challenge could not produce a token; `errorCode` is Cloudflare's client-side error code, when it gave one. */
export class TurnstileError extends Error {
  constructor(
    readonly reason: TurnstileFailureReason,
    readonly attempts: number,
    readonly errorCode?: string
  ) {
    super(`turnstile-${reason}`);
    this.name = 'TurnstileError';
  }
}

/** The user dismissed the interactive challenge. Not a failure, so it is never retried or reported. */
export class TurnstileCancelledError extends Error {
  constructor() {
    super('turnstile-cancelled');
    this.name = 'TurnstileCancelledError';
  }
}

/**
 * Cloudflare's 6xxxxx codes mean the visitor was judged bot-like; 3xxxxx are generic client execution
 * failures that usually mean the same, though a widget crash can also produce one. Embedded browsers
 * (in-app panes, Electron webviews with an unknown user-agent token) hit these on every attempt, so once
 * retries are spent a refresh rarely helps; the message is hedged for the occasional crash.
 */
const BROWSER_REJECTED_ERROR_CODE = /^[36]/;

export const TURNSTILE_RETRY_MESSAGE = 'Could not complete the verification check. Please refresh and try again.';
export const TURNSTILE_BROWSER_REJECTED_MESSAGE =
  'This browser could not pass the verification check. If it is an in-app browser, open this page in your regular browser.';

/** The sign-in error to show once a challenge has finally failed; cancellation is handled by the caller. */
export function turnstileFailureMessage(error: unknown): string {
  if (
    error instanceof TurnstileError &&
    error.reason === 'error' &&
    error.errorCode &&
    BROWSER_REJECTED_ERROR_CODE.test(error.errorCode)
  ) {
    return TURNSTILE_BROWSER_REJECTED_MESSAGE;
  }
  return TURNSTILE_RETRY_MESSAGE;
}

let scriptPromise: Promise<TurnstileApi> | undefined;
let challengeCount = 0;
let challengeInFlight: Promise<unknown> = Promise.resolve();
/** Bumped on every Cancel, so challenges queued behind the cancelled one are dismissed too. */
let cancelCount = 0;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (reason: TurnstileFailureReason) => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      scriptPromise = undefined;
      script.remove();
      reject(new TurnstileError(reason, 1));
    };
    const timer = setTimeout(() => fail('script-timeout'), CHALLENGE_TIMEOUT_MS);
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (!window.turnstile) {
        fail('unavailable');
        return;
      }
      clearTimeout(timer);
      resolve(window.turnstile);
    };
    script.onerror = () => fail('script-error');
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** A failed script request is retried once at once; a stalled one already spent the full timeout. */
async function loadTurnstileWithRetry(): Promise<TurnstileApi> {
  try {
    return await loadTurnstile();
  } catch (error) {
    if (!(error instanceof TurnstileError) || error.reason !== 'script-error') throw error;
    try {
      return await loadTurnstile();
    } catch (retryError) {
      if (retryError instanceof TurnstileError) throw new TurnstileError(retryError.reason, 2);
      throw retryError;
    }
  }
}

const isRetryable = (error: TurnstileError) =>
  error.reason === 'error' && !(error.errorCode && NON_RETRYABLE_ERROR_CODE.test(error.errorCode));

type WidgetOptions = { sitekey: string; action: string; theme: 'light' | 'dark'; size: 'normal' | 'compact' };

/**
 * Renders one widget into `container` and settles with its token, always removing the widget.
 * `onInteractive` runs when Cloudflare needs the user; `signal` aborts the attempt as cancelled.
 */
async function solveOnce(
  turnstile: TurnstileApi,
  container: HTMLElement,
  widget: WidgetOptions,
  attempt: number,
  signal: AbortSignal,
  onInteractive: () => void
): Promise<string> {
  let widgetId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(() => reject(new TurnstileError('timeout', attempt))), CHALLENGE_TIMEOUT_MS);
      };
      armTimeout();
      const settle = (fn: () => void) => {
        settled = true;
        clearTimeout(timer);
        fn();
      };
      onAbort = () => settle(() => reject(new TurnstileCancelledError()));
      signal.addEventListener('abort', onAbort);
      try {
        widgetId = turnstile.render(container, {
          ...widget,
          appearance: 'interaction-only',
          // We retry with a fresh widget below; Cloudflare's own auto-retry would race it.
          retry: 'never',
          'before-interactive-callback': () => {
            if (settled) return;
            // Give the user the full window to solve the card, not what is left after the invisible attempt.
            armTimeout();
            onInteractive();
          },
          callback: token => settle(() => resolve(token)),
          'error-callback': errorCode => {
            settle(() => reject(new TurnstileError('error', attempt, errorCode)));
            // Handled: stops Cloudflare from also logging its own console warning.
            return true;
          },
          'expired-callback': () => settle(() => reject(new TurnstileError('expired', attempt))),
        });
      } catch {
        settle(() => reject(new TurnstileError('render-failed', attempt)));
      }
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (widgetId !== undefined) turnstile.remove(widgetId);
  }
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TurnstileCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TurnstileCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Solves a Turnstile challenge and resolves with a single-use token. The widget stays invisible
 * unless Cloudflare needs interaction, in which case it is shown in a card over a dimmed backdrop until solved.
 * Rejects with a TurnstileError once retries are spent, or a TurnstileCancelledError if the user cancels.
 * Concurrent calls run one at a time, since each card makes everything else on the page inert, and a
 * Cancel also dismisses any call queued behind it: the user declined the check, not just one card.
 * Each dismissed caller rejects on its own, so a caller that queued several calls sees one cancel per call.
 */
export async function getTurnstileToken(siteKey: string, action: string): Promise<string> {
  const turnstile = await loadTurnstileWithRetry();
  const cancelsBefore = cancelCount;
  const challenge = challengeInFlight.then(() => {
    if (cancelCount !== cancelsBefore) throw new TurnstileCancelledError();
    return solveChallenge(turnstile, siteKey, action);
  });
  challengeInFlight = challenge.catch(() => undefined);
  return challenge;
}

async function solveChallenge(turnstile: TurnstileApi, siteKey: string, action: string): Promise<string> {
  const dark = document.documentElement.getAttribute('data-joy-color-scheme') === 'dark';
  const overlay = document.createElement('div');
  overlay.setAttribute('data-testid', 'turnstile-challenge-overlay');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:10001;pointer-events:none';
  const card = document.createElement('div');
  card.setAttribute('data-testid', 'turnstile-challenge-card');
  const message = document.createElement('p');
  message.id = `turnstile-challenge-message-${++challengeCount}`;
  message.textContent = 'Quick security check - confirm you are human to continue.';
  message.style.cssText = 'display:none;margin:0 0 16px;font:14px/1.4 system-ui,sans-serif';
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'turnstile-challenge-widget');
  container.style.pointerEvents = 'auto';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('data-testid', 'turnstile-challenge-cancel');
  cancel.style.cssText =
    'display:none;margin:16px auto 0;padding:6px 16px;border:0;border-radius:8px;background:transparent;color:inherit;font:14px system-ui,sans-serif;cursor:pointer;text-decoration:underline';
  // Focus sentinels also catch Tab leaving the cross-origin iframe, whose key events do not bubble.
  const startSentinel = document.createElement('span');
  const endSentinel = document.createElement('span');
  for (const sentinel of [startSentinel, endSentinel]) sentinel.tabIndex = -1;
  // Turnstile renders into a closed shadow root, so its iframe can't be queried or focused directly.
  // Parking focus on startSentinel instead lets the browser's own Tab step into the widget next.
  let parkingFocus = false;
  const focusBeforeWidget = () => {
    parkingFocus = true;
    startSentinel.focus();
    parkingFocus = false;
  };
  startSentinel.onfocus = () => {
    if (!parkingFocus) cancel.focus();
  };
  endSentinel.onfocus = focusBeforeWidget;
  card.append(startSentinel, message, container, cancel, endSentinel);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // aria-modal is only a hint to assistive tech: inert is what actually keeps focus and clicks
  // out of the page behind the card, including anything stacked above the backdrop (e.g. banners).
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const inertedByUs: HTMLElement[] = [];
  const makeBackgroundInert = () => {
    for (const el of Array.from(document.body.children)) {
      if (el !== overlay && el instanceof HTMLElement && !el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        inertedByUs.push(el);
      }
    }
  };
  const backgroundObserver = new MutationObserver(makeBackgroundInert);

  // The overlay stays bare and click-through on the invisible path; the backdrop and card only
  // appear once Cloudflare decides the user must interact, so no empty modal flashes.
  let interactive = false;
  let finished = false;
  const containFocus = (event: FocusEvent) => {
    if (event.target instanceof Node && !card.contains(event.target)) cancel.focus();
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel.click();
      return;
    }
    if (event.key !== 'Tab') return;
    // The widget owns its internal tab order; only wrap at the card's outer boundary.
    if (event.shiftKey && (document.activeElement === startSentinel || document.activeElement === card)) {
      event.preventDefault();
      cancel.focus();
    } else if (!event.shiftKey && (document.activeElement === cancel || document.activeElement === card)) {
      // No preventDefault: the default Tab action advances from startSentinel into the widget.
      focusBeforeWidget();
    }
  };
  const showChrome = () => {
    if (interactive || finished) return;
    interactive = true;
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.pointerEvents = 'auto';
    card.style.cssText = `background:${dark ? '#1f2329' : '#fff'};color:${dark ? '#e6e8eb' : '#1f2329'};padding:20px 24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.3);box-sizing:border-box;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;text-align:center`;
    message.style.display = 'block';
    cancel.style.display = 'block';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', message.id);
    card.tabIndex = -1;
    makeBackgroundInert();
    backgroundObserver.observe(document.body, { childList: true });
    startSentinel.tabIndex = 0;
    endSentinel.tabIndex = 0;
    document.addEventListener('focusin', containFocus);
    card.focus();
  };

  // The backdrop blocks the page, so give the user a way out of a stuck challenge.
  const cancelling = new AbortController();
  cancel.onclick = () => {
    cancelCount++;
    cancelling.abort();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (interactive) handleKeydown(e);
  };
  document.addEventListener('keydown', onKeyDown);
  const widget: WidgetOptions = {
    sitekey: siteKey,
    action,
    theme: dark ? 'dark' : 'light',
    // The normal widget is 300px wide and overflows the card on narrow screens.
    size: window.innerWidth < 380 ? 'compact' : 'normal',
  };

  // One card spans every attempt: each retry renders a fresh widget into the same container.
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await solveOnce(turnstile, container, widget, attempt, cancelling.signal, showChrome);
      } catch (error) {
        if (!(error instanceof TurnstileError) || !isRetryable(error) || attempt >= MAX_CHALLENGE_ATTEMPTS) throw error;
        await retryDelay(cancelling.signal);
      }
    }
  } finally {
    finished = true;
    document.removeEventListener('keydown', onKeyDown);
    backgroundObserver.disconnect();
    document.removeEventListener('focusin', containFocus);
    overlay.remove();
    for (const el of inertedByUs) el.removeAttribute('inert');
    if (interactive) previouslyFocused?.focus();
  }
}
