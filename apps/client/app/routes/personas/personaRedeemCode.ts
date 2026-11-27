import { isAxiosError } from 'axios';
import { PERSONA_REDEEM_PATH } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

let capturedCode: string | undefined;

/**
 * Moves the `#code=` of a persona login_path (see pages/api/v1/personas/index.ts) out of the address
 * into this module, so no later navigation, Referer or history entry carries it. Runs in the route's
 * beforeLoad, before the page renders.
 */
export function captureCodeFromFragment(): void {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
  if (!code) return;
  capturedCode = code;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
}

export function getCapturedCode(): string | undefined {
  return capturedCode;
}

export type RedeemResult = { ok: true } | { ok: false; message: string };

const FALLBACK_MESSAGE = 'This login link could not be used. Mint a new persona login code and try again.';

/** POSTs the code to pages/api/personas/redeem.ts, which sets the browser's session cookie on success. */
export async function redeemPersonaCode(code: string): Promise<RedeemResult> {
  try {
    await api.post(PERSONA_REDEEM_PATH, { code, session: 'browser' });
    return { ok: true };
  } catch (error) {
    const serverMessage: unknown = isAxiosError(error) ? error.response?.data?.error : undefined;
    return { ok: false, message: typeof serverMessage === 'string' ? serverMessage : FALLBACK_MESSAGE };
  }
}
