import {
  CuratedCatalogSchema,
  MIN_CHAT_CONTEXT,
  parseHubManifest,
  type HubEntry,
  type HubManifest,
} from '@bike4mind/common';
import {
  CURATED_MAX_MANIFEST_BYTES,
  CURATED_MAX_SIGNATURE_BYTES,
  isAbliteratedModel,
  parseCuratedKey,
  readCapped,
  verifyCurated,
  type CuratedKey,
} from '@bike4mind/local-models';
import { curatedDevKeys } from './devKey';

export const KEYRING_PATH = 'apps/desktop/src/main/models/curated/keys.json';
export const CANONICAL_KEYRING_URL = `https://raw.githubusercontent.com/Bike4Mind/bike4mind/main/${KEYRING_PATH}`;
/** The largest step a publish may take over the live sequence; a first publish counts from 0. */
export const MAX_SEQUENCE_STEP = 1000;
const MAX_KEYRING_BYTES = 64 * 1024;

export interface CuratedCandidate {
  manifest: Uint8Array;
  sig: Uint8Array;
  catalog: HubManifest & { sequence: number };
  signers: CuratedKey[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A GET over HTTPS with a 15 s timeout and no redirects; anything but a 200 under the size cap throws. */
export async function fetchKeyringText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (new URL(url).protocol !== 'https:') throw new Error(`${url} is not https`);
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readCapped(response, MAX_KEYRING_BYTES));
}

/**
 * The keyring on the canonical repo's `main`, never a local ref or the working tree, so a branch or a stale clone
 * cannot pick the keys. Anything unreadable or malformed throws, which stops the run.
 */
export async function readMainKeyring(
  read: (url: string) => Promise<string> = url => fetchKeyringText(url)
): Promise<CuratedKey[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await read(CANONICAL_KEYRING_URL));
  } catch (error) {
    throw new Error(`could not read the keyring from ${CANONICAL_KEYRING_URL}: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${KEYRING_PATH} on main is not an array`);
  return raw.map((entry, i) => {
    const key = parseCuratedKey(entry);
    if (!key) throw new Error(`${KEYRING_PATH} on main has an invalid entry at index ${i}`);
    return key;
  });
}

// Must stay in sync with listable() in apps/desktop/src/main/models/ModelHubService.ts: a pick that fails it is
// silently left out of its slot on every Desktop.
function slottable(entry: HubEntry, manifest: HubManifest): boolean {
  if (entry.flags.abliterated || entry.lineage.variantType === 'abliterated' || entry.license.legal === 'blocked')
    return false;
  if (entry.roles.includes('chat') && entry.arch.contextMax < MIN_CHAT_CONTEXT) return false;
  const sources = entry.builds.map(
    build => build.hf?.repo ?? (build.ollama?.kind === 'library' ? build.ollama.ref : '')
  );
  if (isAbliteratedModel({ id: entry.id, tags: [entry.name, ...sources], baseModels: [entry.lineage.base] }))
    return false;
  const permissive = entry.license.class === 'permissive' && entry.license.base.class === 'permissive';
  return permissive || manifest.policy.restrictedLicense === 'curated-labelled';
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

/**
 * Every check a list must pass before any upload: size caps, a signature from a production key in `keyring` (never
 * the public test key alone), the strict catalog schema, nothing a client would drop, and every authored pick slottable.
 */
export function verifyCandidate(
  manifest: Uint8Array,
  sig: Uint8Array,
  keyring: readonly CuratedKey[],
  revoked: ReadonlySet<string> = new Set()
): Checked<CuratedCandidate> {
  if (manifest.byteLength > CURATED_MAX_MANIFEST_BYTES)
    return { ok: false, error: `the list is over ${CURATED_MAX_MANIFEST_BYTES} bytes` };
  if (sig.byteLength > CURATED_MAX_SIGNATURE_BYTES)
    return { ok: false, error: `the signature file is over ${CURATED_MAX_SIGNATURE_BYTES} bytes` };
  const dev = curatedDevKeys().map(({ keyId, spki, role }): CuratedKey => ({ keyId, spki, role }));
  const keys = keyring.filter(key => !dev.some(devKey => devKey.keyId === key.keyId));
  if (keys.length === 0) return { ok: false, error: `${KEYRING_PATH} on main holds no production key` };
  const verified = verifyCurated(manifest, sig, keys, revoked);
  if (!verified.ok) {
    if (verifyCurated(manifest, sig, dev).ok)
      return { ok: false, error: 'the list is signed only by the public test key' };
    return { ok: false, error: `${verified.reason}: ${verified.detail}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
  } catch {
    return { ok: false, error: 'the list is not UTF-8 JSON' };
  }
  const strict = CuratedCatalogSchema.safeParse(raw);
  if (!strict.success) return { ok: false, error: `the list fails the catalog schema: ${issues(strict.error)}` };
  const { dropped } = parseHubManifest(raw);
  if (dropped.length > 0)
    return {
      ok: false,
      error: `clients would drop part of the list: ${dropped.map(drop => `${drop.path} (${drop.reason})`).join('; ')}`,
    };
  const catalog = strict.data as HubManifest & { sequence: number };
  const isRecovery = (id: string) => keyring.some(key => key.keyId === id && key.role === 'recovery');
  const recoveryIds = catalog.revokedKeyIds.filter(isRecovery);
  if (recoveryIds.length > 0)
    return { ok: false, error: `revokedKeyIds names recovery key ${recoveryIds.join(', ')}, which cannot be revoked` };
  for (const tier of catalog.tiers)
    for (const pick of tier.picks) {
      const entry = catalog.entries.find(candidate => candidate.id === pick.entry);
      if (entry && !slottable(entry, catalog))
        return { ok: false, error: `${pick.entry} cannot fill the ${pick.slot} slot of a ${tier.memoryKind} tier` };
    }
  return { ok: true, value: { manifest, sig, catalog, signers: verified.keys } };
}

export type PublishPlan =
  | { kind: 'first-publish' }
  | { kind: 'publish'; liveSequence: number }
  | { kind: 'already-live'; liveSequence: number }
  | { kind: 'behind-live'; liveSequence: number; reason: string }
  | { kind: 'refused'; reason: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/**
 * Compares a verified candidate with the verified live list. Lower or equal-but-different is `behind-live`, which the
 * workflow reports as a sync lag. Refused: a step over MAX_SEQUENCE_STEP, revocations without a recovery
 * signature, a rewritten changelog, a dropped revocation or an earlier `updatedAt`.
 */
export function planPublish(candidate: CuratedCandidate, live: CuratedCandidate | null): PublishPlan {
  const next = candidate.catalog;
  const liveSequence = live?.catalog.sequence ?? 0;
  if (live && next.sequence === liveSequence && sameBytes(candidate.manifest, live.manifest))
    return { kind: 'already-live', liveSequence };
  if (live && next.sequence <= liveSequence)
    return {
      kind: 'behind-live',
      liveSequence,
      reason: `sequence ${next.sequence} is not above live sequence ${liveSequence}`,
    };
  if (next.sequence - liveSequence > MAX_SEQUENCE_STEP)
    return {
      kind: 'refused',
      reason: `sequence ${next.sequence} is more than ${MAX_SEQUENCE_STEP} above live sequence ${liveSequence}`,
    };
  // Every list carries the whole revoked set under a recovery signature, so any later list can rebuild a lost one.
  if (next.revokedKeyIds.length > 0 && !candidate.signers.some(key => key.role === 'recovery'))
    return {
      kind: 'refused',
      reason: `revokedKeyIds names ${next.revokedKeyIds.join(', ')}, so a recovery key must co-sign the list`,
    };
  if (!live) return { kind: 'first-publish' };
  const current = live.catalog;
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt))
    return { kind: 'refused', reason: `updatedAt ${next.updatedAt} is earlier than live ${current.updatedAt}` };
  const kept = next.changelog.filter(item => item.sequence <= current.sequence);
  if (JSON.stringify(kept) !== JSON.stringify(current.changelog.slice(0, kept.length)))
    return { kind: 'refused', reason: 'changelog items already live were changed or removed; only prepend new ones' };
  const missing = current.revokedKeyIds.filter(id => !next.revokedKeyIds.includes(id));
  if (missing.length > 0) return { kind: 'refused', reason: `revokedKeyIds drops ${missing.join(', ')}` };
  return { kind: 'publish', liveSequence: current.sequence };
}
