import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { z } from 'zod';
import type { VoiceHold } from './settleVoiceHold';

const logger = new Logger({ metadata: { service: 'measureVoiceCall' } });

const ProviderConversationSchema = z.object({
  status: z.enum(['initiated', 'in-progress', 'processing', 'done', 'failed']),
  metadata: z.object({ call_duration_secs: z.number().nonnegative() }),
});

// A conversation the browser just opened may not be in the provider's lookup yet; a 404 inside
// this window means "not yet", past it means the transport never connected.
export const PROVIDER_RECORD_GRACE_SECONDS = 30;
const PROVIDER_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * How long a held call ran, as the caller of settleVoiceHold should bill it.
 * - `measured`: bill `elapsedSeconds`. From the provider's own record when the hold carries
 *   provider conversation ids, so offline time and a transport that never connected cost nothing;
 *   wall clock otherwise (the OpenAI realtime path, or a provider that issued no id). A
 *   conversation the provider still has no record of past the grace window never connected and
 *   costs nothing. Session turns can't stand in for it: a v2 voice turn is an ordinary chat quest,
 *   so a message typed after the failed connect would be billed as call time. The miss is logged
 *   so a provider that lost the record (a rotated workspace key) is visible.
 * - `live`: the provider still has the call open. Settling now would bill a running call at its
 *   duration so far, so the caller must wait.
 * - `pending`: the provider has no record yet, within the grace window.
 * - `unverifiable`: the provider lookup failed or no key is configured.
 */
export type VoiceCallMeasurement =
  | { kind: 'measured'; elapsedSeconds: number; source: 'provider' | 'wall-clock' }
  | { kind: 'live' }
  | { kind: 'pending' }
  | { kind: 'unverifiable'; reason: string };

type ProviderLookup =
  | { found: true; status: z.infer<typeof ProviderConversationSchema>['status']; durationSeconds: number }
  | { found: false }
  | { failed: string };

async function lookupProviderConversation(conversationId: string, apiKey: string): Promise<ProviderLookup> {
  let response: Response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(PROVIDER_LOOKUP_TIMEOUT_MS),
    });
  } catch (err) {
    return { failed: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.status === 404) return { found: false };
  if (!response.ok) return { failed: `HTTP ${response.status}` };
  const parsed = ProviderConversationSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { failed: 'unexpected response shape' };
  return { found: true, status: parsed.data.status, durationSeconds: parsed.data.metadata.call_duration_secs };
}

export async function measureVoiceCallSeconds(hold: VoiceHold, now: Date = new Date()): Promise<VoiceCallMeasurement> {
  const wallClockSeconds = Math.max(0, Math.floor((now.getTime() - hold.voiceSessionStartedAt.getTime()) / 1000));
  const conversationIds = hold.voiceProviderConversationIds ?? [];
  if (conversationIds.length === 0) {
    return { kind: 'measured', elapsedSeconds: wallClockSeconds, source: 'wall-clock' };
  }

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['elevenLabsServerApiKey'] }
  );
  const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
  if (!apiKey) return { kind: 'unverifiable', reason: 'elevenLabsServerApiKey is not configured' };

  const lookups = await Promise.all(conversationIds.map(id => lookupProviderConversation(id, apiKey)));
  let totalSeconds = 0;
  const missingIds: string[] = [];
  for (const [i, lookup] of lookups.entries()) {
    if ('failed' in lookup) return { kind: 'unverifiable', reason: lookup.failed };
    if (!lookup.found) {
      if (wallClockSeconds < PROVIDER_RECORD_GRACE_SECONDS) return { kind: 'pending' };
      missingIds.push(conversationIds[i]);
      continue;
    }
    if (lookup.status === 'initiated' || lookup.status === 'in-progress') return { kind: 'live' };
    totalSeconds += lookup.durationSeconds;
  }
  if (missingIds.length > 0) {
    logger.warn('[measureVoiceCall] provider has no record of the conversation; billing it as never connected', {
      sessionId: hold.id,
      conversationIds: missingIds,
    });
  }
  return { kind: 'measured', elapsedSeconds: Math.ceil(totalSeconds), source: 'provider' };
}
