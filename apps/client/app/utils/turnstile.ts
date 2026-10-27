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
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2000;pointer-events:none';
  const card = document.createElement('div');
  card.setAttribute('data-testid', 'turnstile-challenge-card');
  const message = document.createElement('p');
  message.id = 'turnstile-challenge-message';
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
  card.append(message, container, cancel);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // The overlay stays bare and click-through on the invisible path; the backdrop and card only
  // appear once Cloudflare decides the user must interact, so no empty modal flashes.
  const showChrome = () => {
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.pointerEvents = 'auto';
    card.style.cssText = `background:${dark ? '#1f2329' : '#fff'};color:${dark ? '#e6e8eb' : '#1f2329'};padding:20px 24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.3);max-width:calc(100vw - 32px);text-align:center`;
    message.style.display = 'block';
    cancel.style.display = 'block';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', message.id);
  };

  let widgetId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('turnstile-timeout')), CHALLENGE_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      // The backdrop blocks the page, so give the user a way out of a stuck challenge.
      cancel.onclick = () => settle(() => reject(new Error('turnstile-cancelled')));
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
        theme: dark ? 'dark' : 'light',
        'before-interactive-callback': showChrome,
        callback: token => settle(() => resolve(token)),
        'error-callback': () => settle(() => reject(new Error('turnstile-error'))),
        'expired-callback': () => settle(() => reject(new Error('turnstile-expired'))),
      });
    });
  } finally {
    clearTimeout(timer);
    try {
      if (widgetId !== undefined) turnstile.remove(widgetId);
    } finally {
      overlay.remove();
    }
  }
}
