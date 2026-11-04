import { settingsMap, type SettingKey } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TIMEOUT_MS = 20_000;
// BedrockNews keeps up to 254 characters, the longest an email can be.
const LABEL_MAX = 254;
const SETTING_NAMES = ['BedrockNewsApiUrl', 'BedrockNewsPartnerKey'] as const satisfies readonly SettingKey[];

export type ClaimResult = {
  claimed: { date: string; length: number; credits: number; alreadyPaid: boolean }[];
  total: number;
  balance: number | null;
  firstSolveCredits: number;
  capped: number;
};

export const TICKET_STATUSES = ['open', 'redeeming', 'redeemed', 'expired'] as const;

export type TicketPreview = {
  status: (typeof TICKET_STATUSES)[number];
  expiresAt: string;
  rungs: { date: string; length: 5 | 6 | 7; hard: boolean }[];
  result?: ClaimResult;
};

type Failure = { ok: false; code: string; status: number };

async function partnerConfig(): Promise<{ baseUrl: string; partnerKey: string } | null> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: [...SETTING_NAMES], skipCache: true }
  );
  const setting = (key: (typeof SETTING_NAMES)[number]) =>
    getSettingsValue(key, settings, settingsMap[key].defaultValue ?? '');
  const baseUrl = setting('BedrockNewsApiUrl').trim().replace(/\/+$/, '');
  const partnerKey = setting('BedrockNewsPartnerKey').trim();
  return baseUrl && partnerKey ? { baseUrl, partnerKey } : null;
}

const FAILURE_REASONS: Record<string, string> = { TimeoutError: 'timeout', AbortError: 'aborted' };

// Never log the message: fetch errors quote the URL (ticket) or a rejected header value (partner key).
function warnRequestFailed(error: unknown) {
  const name = typeof (error as { name?: unknown })?.name === 'string' ? (error as { name: string }).name : 'unknown';
  Logger.warn('[partners] bedrocknews ticket request failed', { name, reason: FAILURE_REASONS[name] });
}

async function call<T>(
  ticket: string,
  suffix: string,
  init: { method: string; body?: unknown }
): Promise<{ ok: true; body: T } | Failure> {
  if (!TICKET_PATTERN.test(ticket)) return { ok: false, code: 'TICKET_NOT_FOUND', status: 404 };

  const config = await partnerConfig();
  if (!config) return { ok: false, code: 'NOT_CONFIGURED', status: 503 };

  try {
    const response = await fetch(`${config.baseUrl}/api/headword/partner/tickets/${ticket}${suffix}`, {
      method: init.method,
      headers: {
        'X-Partner-Key': config.partnerKey,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      return body === null
        ? { ok: false, code: 'BEDROCKNEWS_UNAVAILABLE', status: 502 }
        : { ok: true, body: body as T };
    }
    const code = typeof body?.code === 'string' ? body.code : 'BEDROCKNEWS_UNAVAILABLE';
    return { ok: false, code, status: response.status };
  } catch (error) {
    warnRequestFailed(error);
    return { ok: false, code: 'BEDROCKNEWS_UNAVAILABLE', status: 502 };
  }
}

export async function previewTicket(ticket: string): Promise<{ ok: true; preview: TicketPreview } | Failure> {
  const res = await call<TicketPreview>(ticket, '', { method: 'GET' });
  return res.ok ? { ok: true, preview: res.body } : res;
}

export async function redeemTicket(
  ticket: string,
  user: { id: string; email: string }
): Promise<{ ok: true; result: ClaimResult } | Failure> {
  const res = await call<ClaimResult>(ticket, '/redeem', {
    method: 'POST',
    body: { b4mUserId: user.id, b4mAccountLabel: user.email.slice(0, LABEL_MAX) },
  });
  return res.ok ? { ok: true, result: res.body } : res;
}
