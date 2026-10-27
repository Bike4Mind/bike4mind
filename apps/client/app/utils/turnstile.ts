const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CHALLENGE_TIMEOUT_MS = 60_000;
/** Widget errors are often transient (network blips, a flaky challenge), so a few fresh renders run first. */
export const MAX_CHALLENGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_500;
/** 110xxx and 400xxx are site configuration errors (bad site key, domain not allowed): retrying cannot help. */
const NON_RETRYABLE_ERROR_CODE = /^(110|400)/;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: 'interaction-only';
      retry: 'never';
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

let scriptPromise: Promise<TurnstileApi> | undefined;

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

/** Renders one widget into `container` and settles with its token, always removing the widget. */
async function solveOnce(
  turnstile: TurnstileApi,
  container: HTMLElement,
  siteKey: string,
  action: string,
  attempt: number
): Promise<string> {
  let widgetId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new TurnstileError('timeout', attempt)), CHALLENGE_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      try {
        widgetId = turnstile.render(container, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          // We retry with a fresh widget below; Cloudflare's own auto-retry would race it.
          retry: 'never',
          callback: token => settle(() => resolve(token)),
          'error-callback': errorCode => {
            settle(() => reject(new TurnstileError('error', attempt, errorCode)));
            // Handled: stops Cloudflare from also throwing the error as uncaught.
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
    if (widgetId !== undefined) turnstile.remove(widgetId);
  }
}

/**
 * Solves a Turnstile challenge and resolves with a single-use token. The widget stays invisible
 * unless Cloudflare needs interaction, in which case it is shown in a centered overlay until solved.
 * Rejects with a TurnstileError once retries are spent.
 */
export async function getTurnstileToken(siteKey: string, action: string): Promise<string> {
  const turnstile = await loadTurnstileWithRetry();

  const overlay = document.createElement('div');
  overlay.setAttribute('data-testid', 'turnstile-challenge-overlay');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2000;pointer-events:none';
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'turnstile-challenge-widget');
  container.style.pointerEvents = 'auto';
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await solveOnce(turnstile, container, siteKey, action, attempt);
      } catch (error) {
        if (!(error instanceof TurnstileError) || !isRetryable(error) || attempt >= MAX_CHALLENGE_ATTEMPTS) throw error;
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  } finally {
    overlay.remove();
  }
}
