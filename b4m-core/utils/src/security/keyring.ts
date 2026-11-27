/**
 * Process-wide at-rest key ring.
 *
 * State lives on a `globalThis` slot rather than in module scope so every copy of this module in a
 * process (the hosted ChatCompletion process loads an ESM and a CJS copy of @bike4mind/utils) reads
 * and writes the same keys. Keys are loaded once, asynchronously, by `ensureKeyring`; everything
 * else reads them synchronously and throws if nothing has loaded, so a missed boot call is loud
 * instead of a silent fallback to some other key source.
 */
import { isValidEncryptionKey } from './secretEncryption';

export interface StageDataKey {
  /** Provisional, non-secret identifier. Never derived from the plaintext key. */
  id: string;
  /** 32-byte hex key. */
  key: string;
}

export interface KeyProvider {
  name: 'static' | 'aws-kms';
  /** Resolves null when the provider has no key (self-host without one). Rejects on a failed unwrap. */
  load(): Promise<StageDataKey | null>;
}

export interface AtRestKeys {
  current?: string;
  previous?: string;
}

export class KeyringNotLoadedError extends Error {
  constructor() {
    super('At-rest keyring is not loaded; call ensureKeyring (connectDB or ensureKeyringLoaded) first');
    this.name = 'KeyringNotLoadedError';
  }
}

interface KeyringState {
  legacy: AtRestKeys | null;
  stageDataKey: StageDataKey | null;
  providerSettled: boolean;
  /** Epoch ms of the last failed provider load; paces retries without caching the failure. */
  lastFailureAt: number | null;
  inflight: Promise<void> | null;
  /** Bumped by loadStaticKeyring so a provider load already in flight cannot overwrite it. */
  generation: number;
}

const SLOT = Symbol.for('bike4mind.secretsAtRest.keyring');
type GlobalWithKeyring = typeof globalThis & { [SLOT]?: KeyringState };

function state(): KeyringState {
  const g = globalThis as GlobalWithKeyring;
  return (g[SLOT] ??= {
    legacy: null,
    stageDataKey: null,
    providerSettled: false,
    lastFailureAt: null,
    inflight: null,
    generation: 0,
  });
}

/** After a failed provider load, calls inside this window skip the provider instead of each waiting on it. */
export const PROVIDER_RETRY_COOLDOWN_MS = 30_000;

const usable = (key: string | undefined): string | undefined => (key && isValidEncryptionKey(key) ? key : undefined);

export interface EnsureKeyringOptions {
  provider: KeyProvider;
  /** Static SECRET_ENCRYPTION_KEY, used for v1/v2 ciphertext. */
  legacyKey?: string;
  legacyPrevious?: string;
}

/**
 * Loads the keyring. Legacy keys are available as soon as this is called, even if the provider
 * then fails. A failed provider load is never cached: it is retried once PROVIDER_RETRY_COOLDOWN_MS
 * has passed (calls inside the window resolve without touching the provider, so an outage does not
 * stall every request). Concurrent calls share one provider load; once a load has settled, later
 * calls are no-ops.
 */
export function ensureKeyring(opts: EnsureKeyringOptions): Promise<void> {
  const s = state();
  if (s.providerSettled) return Promise.resolve();
  if (s.inflight) return s.inflight;
  if (s.legacy && s.lastFailureAt !== null && Date.now() - s.lastFailureAt < PROVIDER_RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  s.legacy = { current: usable(opts.legacyKey), previous: usable(opts.legacyPrevious) };
  const generation = s.generation;
  const run = opts.provider.load().then(
    key => {
      if (s.generation !== generation) return;
      s.stageDataKey = key;
      s.providerSettled = true;
      s.lastFailureAt = null;
      s.inflight = null;
    },
    (error: unknown) => {
      if (s.generation === generation) {
        s.lastFailureAt = Date.now();
        s.inflight = null;
      }
      throw error;
    }
  );
  s.inflight = run;
  return run;
}

/**
 * Synchronously loads a static keyring (self-host, scripts, tests). It is an explicit override: it
 * settles the keyring, so a provider load is neither started nor applied afterwards, including one
 * already in flight.
 */
export function loadStaticKeyring(key: string | undefined, previous?: string): void {
  const s = state();
  const current = usable(key);
  s.legacy = { current, previous: usable(previous) };
  s.stageDataKey = current ? { id: 'static', key: current } : null;
  s.providerSettled = true;
  s.lastFailureAt = null;
  s.inflight = null;
  s.generation++;
}

/** True once the provider load has succeeded (or a static keyring was loaded). */
export function isKeyringSettled(): boolean {
  return state().providerSettled;
}

export function isKeyringLoaded(): boolean {
  return state().legacy !== null;
}

/** The static keys for v1/v2 ciphertext. Throws KeyringNotLoadedError before any load. */
export function getAtRestKeys(): AtRestKeys {
  const { legacy } = state();
  if (!legacy) throw new KeyringNotLoadedError();
  return legacy;
}

/** The provider-supplied data key, or null when the provider has none or has not succeeded yet. */
export function getStageDataKey(): StageDataKey | null {
  const s = state();
  if (!s.legacy) throw new KeyringNotLoadedError();
  return s.stageDataKey;
}

/** @internal Test-only: wipes the process-wide key slot. Do not call from production code. */
export function resetKeyringForTests(): void {
  delete (globalThis as GlobalWithKeyring)[SLOT];
}
