/**
 * Fetches and caches the ElevenLabs workspace voices list. The list rarely
 * changes (admins occasionally add/remove voices in the dashboard) so a
 * 15-minute in-memory TTL is plenty. Keyed on the API key so per-environment
 * caches (dev/staging/prod, test fixtures) don't bleed into each other.
 */

export interface ElevenLabsVoice {
  id: string;
  name: string;
  /** Provider-supplied labels (accent, gender, age, descriptive). May be empty. */
  labels: Record<string, string>;
  /** Short preview MP3 URL hosted by ElevenLabs. May be undefined. */
  previewUrl?: string;
}

interface CacheEntry {
  key: string;
  voices: ElevenLabsVoice[];
  expiresAt: number;
}

const VOICES_ENDPOINT = 'https://api.elevenlabs.io/v1/voices';
const TTL_MS = 15 * 60 * 1000;

let _cache: CacheEntry | null = null;

export interface FetchElevenLabsVoicesOptions {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Bypass the cache and force a refetch. */
  force?: boolean;
}

interface ElevenLabsVoiceRaw {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

interface ElevenLabsVoicesResponse {
  voices: ElevenLabsVoiceRaw[];
}

export async function fetchElevenLabsVoices(
  apiKey: string,
  options: FetchElevenLabsVoicesOptions = {}
): Promise<ElevenLabsVoice[]> {
  if (!apiKey) throw new Error('ElevenLabs API key is required to fetch voices');

  if (!options.force && _cache && _cache.key === apiKey && Date.now() < _cache.expiresAt) {
    return _cache.voices;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(VOICES_ENDPOINT, {
    method: 'GET',
    headers: { 'xi-api-key': apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs voices fetch failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as ElevenLabsVoicesResponse;
  const voices: ElevenLabsVoice[] = (json.voices ?? []).map(v => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels ?? {},
    ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
  }));

  _cache = { key: apiKey, voices, expiresAt: Date.now() + TTL_MS };
  return voices;
}

/** Test-only: drop the cache. */
export function clearElevenLabsVoicesCache(): void {
  _cache = null;
}
