const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CHALLENGE_TIMEOUT_MS = 60_000;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: 'interaction-only';
      theme: 'light' | 'dark';
      size: 'normal' | 'compact';
      'before-interactive-callback': () => void;
      callback: (token: string) => void;
      'error-callback': () => void;
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

let scriptPromise: Promise<TurnstileApi> | undefined;
let challengeCount = 0;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      scriptPromise = undefined;
      script.remove();
      reject(new Error('turnstile-unavailable'));
    };
    const timer = setTimeout(fail, CHALLENGE_TIMEOUT_MS);
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (!window.turnstile) {
        fail();
        return;
      }
      clearTimeout(timer);
      resolve(window.turnstile);
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Solves a Turnstile challenge and resolves with a single-use token. The widget stays invisible
 * unless Cloudflare needs interaction, in which case it is shown in a card over a dimmed backdrop until solved.
 */
export async function getTurnstileToken(siteKey: string, action: string): Promise<string> {
  const turnstile = await loadTurnstile();

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
  for (const sentinel of [startSentinel, endSentinel]) {
    sentinel.tabIndex = -1;
    sentinel.setAttribute('aria-hidden', 'true');
  }
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
  let onKeyDown: ((e: KeyboardEvent) => void) | undefined;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armTimeout = () => {};
  const showChrome = () => {
    if (interactive || finished) return;
    interactive = true;
    // Give the user the full window to solve the card, not what is left after the invisible attempt.
    armTimeout();
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

  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('turnstile-timeout')), CHALLENGE_TIMEOUT_MS);
      };
      armTimeout();
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      // The backdrop blocks the page, so give the user a way out of a stuck challenge.
      const cancelChallenge = () => settle(() => reject(new Error('turnstile-cancelled')));
      cancel.onclick = cancelChallenge;
      onKeyDown = e => {
        if (interactive) handleKeydown(e);
      };
      document.addEventListener('keydown', onKeyDown);
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
        theme: dark ? 'dark' : 'light',
        // The normal widget is 300px wide and overflows the card on narrow screens.
        size: window.innerWidth < 380 ? 'compact' : 'normal',
        'before-interactive-callback': showChrome,
        callback: token => settle(() => resolve(token)),
        'error-callback': () => settle(() => reject(new Error('turnstile-error'))),
        'expired-callback': () => settle(() => reject(new Error('turnstile-expired'))),
      });
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
    try {
      if (widgetId !== undefined) turnstile.remove(widgetId);
    } finally {
      backgroundObserver.disconnect();
      document.removeEventListener('focusin', containFocus);
      overlay.remove();
      for (const el of inertedByUs) el.removeAttribute('inert');
      if (interactive) previouslyFocused?.focus();
    }
  }
}
