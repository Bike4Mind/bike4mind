const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CHALLENGE_TIMEOUT_MS = 60_000;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: 'interaction-only';
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
 * unless Cloudflare needs interaction, in which case it is shown in a centered overlay until solved.
 */
export async function getTurnstileToken(siteKey: string, action: string): Promise<string> {
  const turnstile = await loadTurnstile();

  const overlay = document.createElement('div');
  overlay.setAttribute('data-testid', 'turnstile-challenge-overlay');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2000;pointer-events:none';
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'turnstile-challenge-widget');
  container.style.pointerEvents = 'auto';
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  let widgetId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('turnstile-timeout')), CHALLENGE_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
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
