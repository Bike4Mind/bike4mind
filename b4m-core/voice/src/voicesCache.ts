/**
 * Fetches and caches the ElevenLabs workspace voices list. The list rarely
 * changes (admins occasionally add/remove voices in the dashboard) so a
 * 15-minute in-memory TTL is plenty. One entry per API key: the admin key and
 * each user's own key (Studio's picker lists the caller's account) see
 * different workspaces, and must not evict one another.
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
  voices: ElevenLabsVoice[];
  expiresAt: number;
}

const VOICES_ENDPOINT = 'https://api.elevenlabs.io/v1/voices';
const TTL_MS = 15 * 60 * 1000;

// Bounds memory when many users bring their own key; the least recently used entry is evicted first.
const MAX_ENTRIES = 200;

const _cache = new Map<string, CacheEntry>();

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

  const cached = _cache.get(apiKey);
  if (!options.force && cached && Date.now() < cached.expiresAt) {
    // Re-insert so Map order tracks recency and a busy key is not evicted first.
    _cache.delete(apiKey);
    _cache.set(apiKey, cached);
    return cached.voices;
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

  _cache.delete(apiKey);
  _cache.set(apiKey, { voices, expiresAt: Date.now() + TTL_MS });
  const oldest = _cache.keys().next().value;
  if (_cache.size > MAX_ENTRIES && oldest !== undefined) _cache.delete(oldest);
  return voices;
}

/** Test-only: drop the cache. */
export function clearElevenLabsVoicesCache(): void {
  _cache.clear();
}
