import type { ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { boolean, compact, fetchJson, text } from './http';

export const ELEVENLABS_MODELS_URL = 'https://api.elevenlabs.io/v1/models';

/**
 * ElevenLabs is the one source in this set with nowhere to land yet, and that is
 * worth stating rather than hiding behind a plausible-looking `backend`:
 *
 * - `ModelBackend` has no `elevenlabs` member, so these records carry no
 *   `backend` and the catalog write path drops any of them the catalog has never
 *   held (voice models live in `voiceGeneration.ts`, outside the catalog).
 * - Its char limits are CHARACTERS, not tokens, so they are not written to
 *   `contextWindow`; a character count in a token field is a unit lie that later
 *   silently mis-sizes a request.
 * - Its 17 capability booleans (`can_use_style`, `can_do_voice_conversion`, ...)
 *   have no ModelRecord field, and inventing one from a feed is out of bounds.
 *
 * What it does contribute is real: the availability signal - which voice models
 * this account can actually reach - and the fields to fill in once a TTS backend
 * exists. Everything else it publishes is deliberately discarded here rather
 * than emitted and dropped downstream.
 */
interface ElevenLabsModel {
  model_id?: unknown;
  name?: unknown;
  can_do_text_to_speech?: unknown;
  can_do_voice_conversion?: unknown;
}

/** Scribe is the speech-to-text family; everything else on this endpoint speaks. */
function inferType(id: string, model: ElevenLabsModel): ModelRecord['type'] {
  if (id.startsWith('scribe')) return 'speech-to-text';
  return boolean(model?.can_do_text_to_speech) === false ? 'speech-to-text' : 'tts';
}

export function normalizeElevenLabsModels(payload: unknown): DiscoveredModel[] {
  const list = Array.isArray(payload) ? (payload as ElevenLabsModel[]) : [];
  const records: DiscoveredModel[] = [];

  for (const entry of list) {
    const id = text(entry?.model_id);
    if (!id) continue;
    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'elevenlabs',
        type: inferType(id, entry),
        name: text(entry?.name),
        // Not applicable: this provider meters characters, not a token window.
        contextWindow: 0,
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function createElevenLabsSource(): DiscoverySource {
  return {
    name: 'elevenlabs',
    kind: 'provider',
    // Its own admin setting: ElevenLabs is not part of getEffectiveLLMApiKeys.
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.elevenlabs),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const response = await fetchJson<unknown>(
        { url: ELEVENLABS_MODELS_URL, headers: { 'xi-api-key': ctx.credentials.elevenlabs ?? '' } },
        ctx
      );
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

      const records = normalizeElevenLabsModels(response.body);
      if (records.length === 0) return { ok: false, error: 'model list was empty', httpStatus: response.status };

      // No authoritativeFor: absence bookkeeping runs per ModelBackend, and
      // there is no backend these models belong to. Claiming one would retire
      // rows that belong to a different provider entirely.
      return { ok: true, records, httpStatus: response.status };
    },
  };
}
