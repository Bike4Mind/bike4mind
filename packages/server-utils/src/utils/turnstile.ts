import { z } from 'zod';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 2000;
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048;

export type TurnstileResult =
  { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'unavailable'; errorCodes?: string[] };

export type VerifyTurnstileInput = {
  token: unknown;
  secret: string;
  ip?: string;
  expectedAction: string;
  /** Lowercase hostnames the widget may have been solved on; empty skips the hostname check. */
  allowedHostnames?: string[];
  /**
   * Skip the action and hostname checks when `secret` is one of Cloudflare's public test secrets,
   * whose siteverify answers never carry our action or host. Callers must pass false in production.
   */
  allowTestSecret?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  'error-codes': z.array(z.string()).optional(),
});

/** Secrets default to this placeholder on stages that never provisioned a key. */
export function isTurnstileSecretConfigured(secret: string | undefined): secret is string {
  return !!secret && secret.trim() !== '' && secret !== 'not-configured';
}

/**
 * Cloudflare's published test secrets (always pass, always fail, token already spent). They are
 * public, so they are honored only off production (see `allowTestSecret`); on production they keep
 * the strict checks and every token is rejected.
 * See https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const TURNSTILE_TEST_SECRETS: ReadonlySet<string> = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export function isTurnstileTestSecret(secret: string): boolean {
  return TURNSTILE_TEST_SECRETS.has(secret.trim());
}

/**
 * Verifies a Turnstile token with Cloudflare siteverify. Tokens are single-use, so a duplicate or
 * expired token comes back as `invalid`. A network failure, timeout or non-2xx answer is
 * `unavailable` so the caller can choose to fail open or closed.
 */
export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<TurnstileResult> {
  const { token, secret, ip, expectedAction, allowedHostnames = [] } = input;
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };
  if (token.length > TURNSTILE_MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid' };

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  let data: z.infer<typeof siteverifyResponseSchema>;
  try {
    const response = await (input.fetchImpl ?? fetch)(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    data = siteverifyResponseSchema.parse(await response.json());
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  const errorCodes = data['error-codes'];
  if (data.success !== true) {
    // A rejected secret or malformed request is our misconfiguration, not the caller's fault.
    if (
      errorCodes?.some(code =>
        ['internal-error', 'missing-input-secret', 'invalid-input-secret', 'bad-request'].includes(code)
      )
    )
      return { ok: false, reason: 'unavailable', errorCodes };
    return { ok: false, reason: 'invalid', errorCodes };
  }
  if (input.allowTestSecret === true && isTurnstileTestSecret(secret)) return { ok: true };
  if (data.action !== expectedAction) return { ok: false, reason: 'invalid', errorCodes: ['action-mismatch'] };
  if (allowedHostnames.length > 0 && !allowedHostnames.includes((data.hostname ?? '').toLowerCase())) {
    return { ok: false, reason: 'invalid', errorCodes: ['hostname-mismatch'] };
  }
  return { ok: true };
}
