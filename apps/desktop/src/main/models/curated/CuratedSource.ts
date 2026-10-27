import { parseHubManifest, type HubManifest } from '@bike4mind/common';
import {
  CURATED_MAX_MANIFEST_BYTES,
  CURATED_MAX_SIGNATURE_BYTES,
  parseCuratedSignatureFile,
  verifyCurated,
  type CuratedKey,
} from '@bike4mind/local-models';
import type { CuratedCheckStatus, CuratedListSettings, CuratedSourceView } from '@shared/models';
import { loadCuratedManifest } from '../loadCuratedManifest';
import { CuratedStore, type CuratedCheckState } from './CuratedStore';
import { fetchCurated, type CuratedFetchResult } from './fetchCurated';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const CURATED_CHECK_INTERVAL_MS = 6 * HOUR_MS;
export const CURATED_BACKOFF_BASE_MS = 15 * 60 * 1000;
const STALE_LIST_AGE_MS = 180 * DAY_MS;
const STALE_CHECK_AGE_MS = 7 * DAY_MS;

export interface CuratedSourceDeps {
  /** The resolved list URL (`.../latest.json`); null for a build that only has its bundled list. */
  url: string | null;
  /** Keys trusted for this source. With none, nothing is fetched. */
  keys: readonly CuratedKey[];
  store: CuratedStore;
  bundledText: string;
  desktopVersion?: string;
  allowLoopbackHttp: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  log: (message: string) => void;
  /** The shown list or the check status changed. */
  onChange: () => void;
}

type Outcome = 'up-to-date' | 'updated' | 'failed' | 'rejected';

interface Copy {
  manifest: HubManifest;
  sequence: number;
  bytes: Uint8Array;
  signature: Uint8Array | null;
  origin: 'bundled' | 'updated';
}

type Verdict =
  | { ok: true; json: unknown; sequence: number; signedBy: CuratedKey[] }
  | { ok: false; stage: 'signature' | 'content'; detail: string };

const sameBytes = (a: Uint8Array, b: Uint8Array | null) =>
  b !== null && a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/**
 * The Curated tab's list: the bundled copy, or a newer one fetched from the baked URL, verified against this
 * build's keys and kept on disk. Checks run only when Models opens and are due, or on Check now; none at launch.
 * Nothing here throws: every failure keeps the current list and is logged with its reason.
 */
export class CuratedSource {
  readonly #deps: CuratedSourceDeps;
  readonly #source: string | null;
  readonly #bundled: Copy;
  readonly #loaded: Promise<void>;
  #cached: Copy | null = null;
  #state: CuratedCheckState = { lastSuccessAt: null, lastAttemptAt: null, failures: 0 };
  #revoked = new Set<string>();
  #enabled = true;
  #status: 'idle' | 'checking' | Outcome = 'idle';
  #inFlight: Promise<void> | null = null;

  constructor(deps: CuratedSourceDeps) {
    this.#deps = deps;
    this.#source = deps.url ? CuratedStore.sourceKey(deps.url) : null;
    let json: unknown;
    try {
      json = JSON.parse(deps.bundledText);
    } catch {
      json = undefined;
    }
    const manifest = this.#load(json);
    this.#bundled = {
      manifest,
      sequence: manifest.sequence ?? 0,
      bytes: new TextEncoder().encode(deps.bundledText),
      signature: null,
      origin: 'bundled',
    };
    this.#loaded = this.#open();
  }

  get available(): boolean {
    return this.#source !== null && this.#deps.keys.length > 0;
  }

  /** Resolves once the setting and the cached copy are read; the bundled list is current until then. */
  loaded(): Promise<void> {
    return this.#loaded;
  }

  /** The list to show and check pulls against now. Callers snapshot it once per operation. */
  current(): HubManifest {
    return this.#chosen().manifest;
  }

  view(): CuratedSourceView {
    const chosen = this.#chosen();
    const now = this.#now();
    const { lastSuccessAt } = this.#state;
    const age = now - Date.parse(chosen.manifest.updatedAt);
    const checkedRecently = lastSuccessAt !== null && now - lastSuccessAt <= STALE_CHECK_AGE_MS;
    const check: CuratedCheckStatus =
      !this.available || !this.#enabled ? 'off' : this.#status === 'rejected' ? 'failed' : this.#status;
    return {
      origin: chosen.origin,
      sequence: chosen.manifest.sequence ?? null,
      check,
      checkedAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
      stale: age > STALE_LIST_AGE_MS && !checkedRecently,
    };
  }

  settings(): CuratedListSettings {
    return { available: this.available, enabled: this.#enabled };
  }

  async setEnabled(enabled: boolean): Promise<CuratedListSettings> {
    await this.#loaded;
    try {
      await this.#deps.store.writeEnabled(enabled);
    } catch (error) {
      this.#log(`could not save the curated list setting: ${String(error)}`);
    }
    this.#enabled = enabled;
    this.#status = 'idle';
    this.#deps.onChange();
    return this.settings();
  }

  /** Checks when the last success is 6 h old (or the clock moved back) and any failure backoff has passed. */
  async checkIfDue(): Promise<void> {
    await this.#loaded;
    if (this.#inFlight) return this.#inFlight;
    if (!this.available || !this.#enabled || !this.#due(this.#now())) return;
    return this.#start();
  }

  /** Bypasses the throttle and backoff; joins a check already running. */
  async checkNow(): Promise<void> {
    await this.#loaded;
    if (this.#inFlight) return this.#inFlight;
    if (!this.available || !this.#enabled) return;
    return this.#start();
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #log(message: string): void {
    this.#deps.log(`MODELS: ${message}`);
  }

  #load(json: unknown): HubManifest {
    return loadCuratedManifest(this.#deps.log, json, { desktopVersion: this.#deps.desktopVersion });
  }

  #chosen(): Copy {
    const cached = this.#cached;
    return this.available && this.#enabled && cached && cached.sequence > this.#bundled.sequence
      ? cached
      : this.#bundled;
  }

  #due(now: number): boolean {
    const { lastSuccessAt, lastAttemptAt, failures } = this.#state;
    const sinceSuccess = lastSuccessAt === null ? Infinity : now - lastSuccessAt;
    if (sinceSuccess >= 0 && sinceSuccess < CURATED_CHECK_INTERVAL_MS) return false;
    if (failures > 0 && lastAttemptAt !== null) {
      const wait = Math.min(CURATED_BACKOFF_BASE_MS * 2 ** (failures - 1), CURATED_CHECK_INTERVAL_MS);
      const since = now - lastAttemptAt;
      if (since >= 0 && since < wait) return false;
    }
    return true;
  }

  async #open(): Promise<void> {
    const { store } = this.#deps;
    try {
      this.#enabled = await store.readEnabled();
      if (!this.available || !this.#source) return;
      this.#revoked = await store.readRevoked();
      this.#state = await store.readState(this.#source);
      const copy = await store.readCopy(this.#source);
      if (!copy) return;
      const verdict = this.#verify(copy.manifest, copy.signature);
      if (!verdict.ok) {
        this.#log(`deleted the cached curated list: ${verdict.detail}`);
        await store.deleteCopy(this.#source);
        return;
      }
      this.#cached = this.#copy(verdict, copy.manifest, copy.signature);
    } catch (error) {
      this.#log(`could not read the cached curated list: ${String(error)}`);
    }
  }

  #copy(verdict: Extract<Verdict, { ok: true }>, bytes: Uint8Array, signature: Uint8Array): Copy {
    return { manifest: this.#load(verdict.json), sequence: verdict.sequence, bytes, signature, origin: 'updated' };
  }

  /** Size cap and signature, then UTF-8, JSON, the v2 envelope and a sequence; entries are read tolerantly later. */
  #verify(bytes: Uint8Array, signature: Uint8Array): Verdict {
    const signed = verifyCurated(bytes, signature, this.#deps.keys, this.#revoked);
    if (!signed.ok) return { ok: false, stage: 'signature', detail: `${signed.reason}: ${signed.detail}` };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      parseHubManifest(json);
    } catch (error) {
      return { ok: false, stage: 'content', detail: `invalid list: ${error instanceof Error ? error.message : error}` };
    }
    const sequence = (json as { sequence?: unknown }).sequence;
    if (typeof sequence !== 'number') return { ok: false, stage: 'content', detail: 'the list has no sequence' };
    return { ok: true, json, sequence, signedBy: signed.keys };
  }

  #start(): Promise<void> {
    this.#inFlight = this.#check().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #check(): Promise<void> {
    this.#status = 'checking';
    this.#deps.onChange();
    let outcome: Outcome;
    try {
      outcome = await this.#run(this.#deps.url as string);
    } catch (error) {
      this.#log(`curated list check failed: ${String(error)}`);
      outcome = 'failed';
    }
    const now = this.#now();
    this.#state =
      outcome === 'failed' || outcome === 'rejected'
        ? { ...this.#state, lastAttemptAt: now, failures: this.#state.failures + 1 }
        : { lastSuccessAt: now, lastAttemptAt: now, failures: 0 };
    await this.#deps.store.writeState(this.#source as string, this.#state).catch((error: unknown) => {
      this.#log(`could not save the curated check state: ${String(error)}`);
    });
    this.#status = outcome;
    this.#deps.onChange();
  }

  async #fetch(url: string, maxBytes: number): Promise<CuratedFetchResult> {
    const { fetch, timeoutMs, allowLoopbackHttp } = this.#deps;
    const result = await fetchCurated(url, maxBytes, { fetch, timeoutMs, allowLoopbackHttp });
    if (!result.ok) this.#log(`curated list check failed (${result.failure}): ${result.detail}`);
    return result;
  }

  async #run(url: string): Promise<Outcome> {
    const signature = await this.#fetch(`${url}.sig`, CURATED_MAX_SIGNATURE_BYTES);
    if (!signature.ok) return 'failed';
    if (this.#cached && sameBytes(signature.bytes, this.#cached.signature)) return 'up-to-date';
    const latest = await this.#fetch(url, CURATED_MAX_MANIFEST_BYTES);
    if (!latest.ok) return 'failed';

    let pair = { bytes: latest.bytes, signature: signature.bytes };
    let verdict = this.#verify(pair.bytes, pair.signature);
    if (!verdict.ok && verdict.stage === 'signature') {
      // latest.json and its .sig are overwritten separately, so mid-publish they can disagree; the immutable
      // pair the unsigned hint names settles it. The hint itself is never trusted.
      const hint = parseCuratedSignatureFile(signature.bytes)?.sequence ?? null;
      const current = this.#chosen().sequence;
      if (hint === null || hint <= current) {
        this.#log(`latest curated list does not match its signature (${verdict.detail}); kept list ${current}`);
        return 'up-to-date';
      }
      this.#log(`latest curated list does not match its signature (${verdict.detail}); trying ${hint}.json`);
      const pinned = new URL(`${hint}.json`, url).href;
      const pinnedSignature = await this.#fetch(`${pinned}.sig`, CURATED_MAX_SIGNATURE_BYTES);
      if (!pinnedSignature.ok) return 'failed';
      const pinnedList = await this.#fetch(pinned, CURATED_MAX_MANIFEST_BYTES);
      if (!pinnedList.ok) return 'failed';
      pair = { bytes: pinnedList.bytes, signature: pinnedSignature.bytes };
      verdict = this.#verify(pair.bytes, pair.signature);
    }
    if (!verdict.ok) {
      this.#log(`rejected the curated list: ${verdict.detail}`);
      return 'rejected';
    }
    return this.#consider(verdict, pair.bytes, pair.signature);
  }

  /** The sequence rule: higher accepts, equal and identical is up to date, equal and different is equivocation. */
  async #consider(verdict: Extract<Verdict, { ok: true }>, bytes: Uint8Array, signature: Uint8Array): Promise<Outcome> {
    const current = this.#chosen();
    if (verdict.sequence < current.sequence) {
      this.#log(`curated list ${verdict.sequence} is older than the current list ${current.sequence}; kept it`);
      return 'up-to-date';
    }
    if (verdict.sequence === current.sequence) {
      if (sameBytes(bytes, current.bytes)) return 'up-to-date';
      this.#log(`rejected curated list ${verdict.sequence}: it differs from the current list with that sequence`);
      return 'rejected';
    }
    const recovery = verdict.signedBy.some(key => key.role === 'recovery');
    const revoked = (verdict.json as { revokedKeyIds?: string[] }).revokedKeyIds ?? [];
    if (recovery && revoked.length > 0) {
      const revocable = revoked.filter(id => !this.#deps.keys.some(key => key.keyId === id && key.role === 'recovery'));
      this.#revoked = await this.#deps.store.addRevoked(revocable).catch((error: unknown) => {
        this.#log(`could not save revoked keys: ${String(error)}`);
        return new Set([...this.#revoked, ...revocable]);
      });
    }
    this.#cached = this.#copy(verdict, bytes, signature);
    await this.#deps.store.writeCopy(this.#source as string, { manifest: bytes, signature }).catch((error: unknown) => {
      this.#log(`could not cache the curated list: ${String(error)}`);
    });
    const keyIds = verdict.signedBy.map(key => key.keyId).join(', ');
    this.#log(`accepted curated list ${verdict.sequence}, signed by ${keyIds}`);
    return 'updated';
  }
}
