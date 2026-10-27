/**
 * Verifies a signed curated list and publishes it to the catalog bucket; the merge workflow and an out-of-band
 * publish both run this. Exit 3 means the repo is behind live, which the workflow reports as a warning.
 *
 *   pnpm --filter @bike4mind/scripts curated:publish --manifest <path> --sig <path> [--verify-only] [--dry-run]
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCuratedSignatureFile, verifyCurated, type CuratedKey } from '@bike4mind/local-models';
import {
  isRecoverySigned,
  planPublish,
  readMainKeyring,
  verifyCandidate,
  type CuratedCandidate,
  type PublishPlan,
} from './catalogChecks';
import { cliPath, isEntry } from './cli';
import {
  CURATED_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  LATEST_CACHE_CONTROL,
  type PublishStore,
  type StoredObject,
} from './publishStore';

export const EXIT = { ok: 0, failed: 1, usage: 2, behindLive: 3 } as const;

const LATEST = `${CURATED_PREFIX}latest.json`;
const LATEST_SIG = `${LATEST}.sig`;

export interface PublishDeps {
  store: PublishStore;
  keyring: readonly CuratedKey[];
  log: (line: string) => void;
  dryRun: boolean;
  /** The baked list URL, read back through the CDN after a publish; informational only. */
  publicUrl?: string;
  fetch?: typeof fetch;
}

interface Live {
  list: CuratedCandidate | null;
  sigEtag: string | null;
  jsonEtag: string | null;
  /** latest.json.sig is new but latest.json is not: a run stopped between the two writes. */
  midPublish: boolean;
  /** Why the live objects are not a verified list; only a recovery-signed list may replace them. */
  unverifiable: string | null;
  /** The sequence an unverifiable latest.json.sig names, unverified. */
  claimed: number | null;
}

/** Live state from the bucket; a pair caught mid-publish or a lone sig is read through the sig's hint, as clients do. */
async function readLive(deps: PublishDeps): Promise<Live> {
  const [json, sig] = await Promise.all([deps.store.get(LATEST), deps.store.get(LATEST_SIG)]);
  const hint = sig ? (parseCuratedSignatureFile(sig.bytes)?.sequence ?? null) : null;
  const found = { sigEtag: sig?.etag ?? null, jsonEtag: json?.etag ?? null, midPublish: false, claimed: null };
  const unverifiable = (reason: string): Live => ({ ...found, list: null, unverifiable: reason, claimed: hint });
  if (!json && !sig) return { ...found, list: null, unverifiable: null };
  if (!sig) return unverifiable(`${LATEST} is live without ${LATEST_SIG}`);
  let failure = `${LATEST} is missing and ${LATEST_SIG} does not lead to a verified list`;
  if (json) {
    const direct = verifyCandidate(json.bytes, sig.bytes, deps.keyring);
    if (direct.ok) return { ...found, list: direct.value, unverifiable: null };
    failure = `the live list does not verify (${direct.error})`;
  }
  if (hint) {
    const [pairJson, pairSig] = await Promise.all([
      deps.store.get(`${CURATED_PREFIX}${hint}.json`),
      deps.store.get(`${CURATED_PREFIX}${hint}.json.sig`),
    ]);
    const paired = pairJson && pairSig ? verifyCandidate(pairJson.bytes, pairSig.bytes, deps.keyring) : null;
    if (paired?.ok) {
      deps.log(`live is mid-publish; reading it as ${CURATED_PREFIX}${hint}.json`);
      return { ...found, list: paired.value, midPublish: true, unverifiable: null };
    }
  }
  return unverifiable(failure);
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Writes an immutable object, or accepts an identical one already there from an earlier, partial run. */
async function putImmutable(store: PublishStore, key: string, bytes: Uint8Array, log: PublishDeps['log']) {
  if ((await store.put(key, bytes, IMMUTABLE_CACHE_CONTROL, { ifNoneMatch: '*' })) === 'ok') {
    log(`wrote ${key}`);
    return true;
  }
  const existing: StoredObject | null = await store.get(key);
  if (existing && same(existing.bytes, bytes)) {
    log(`${key} is already there with these bytes`);
    return true;
  }
  log(`${key} already exists with different bytes; refusing to overwrite it`);
  return false;
}

/** Steps 5 to 11 for a candidate that already passed `verifyCandidate`; returns the exit code. */
export async function publishCandidate(candidate: CuratedCandidate, deps: PublishDeps): Promise<number> {
  const { store, log } = deps;
  const sequence = candidate.catalog.sequence;
  const live = await readLive(deps);
  if (live.unverifiable && !isRecoverySigned(candidate)) {
    log(`${live.unverifiable}; only a recovery-signed list can replace it`);
    return EXIT.failed;
  }
  // A live list without a recovery signature may come from a leaked key, so its revocations bind nothing.
  if (live.list && isRecoverySigned(live.list)) {
    const revoked = new Set(live.list.catalog.revokedKeyIds);
    const stillTrusted = verifyCurated(candidate.manifest, candidate.sig, deps.keyring, revoked);
    if (!stillTrusted.ok) {
      log(`the list is signed only by keys the live list revokes (${stillTrusted.detail})`);
      return EXIT.failed;
    }
  }

  const plan: PublishPlan | { kind: 'replace' } = live.unverifiable
    ? { kind: 'replace' }
    : planPublish(candidate, live.list);
  switch (plan.kind) {
    case 'already-live':
      if (!live.midPublish) {
        log(`sequence ${sequence} is already live; nothing to do`);
        return EXIT.ok;
      }
      break;
    case 'behind-live':
      log(`the repo is behind live sequence ${plan.liveSequence}: ${plan.reason}; open a sync PR`);
      return EXIT.behindLive;
    case 'refused':
      log(`refused: ${plan.reason}`);
      return EXIT.failed;
  }
  const versioned = `${CURATED_PREFIX}${sequence}.json`;
  const order = [versioned, `${versioned}.sig`, LATEST_SIG, LATEST];
  if (plan.kind === 'first-publish') log(`plan: first publish of sequence ${sequence}`);
  else if (plan.kind === 'already-live') log(`plan: finish the interrupted publish of sequence ${sequence}`);
  else if (plan.kind === 'replace') {
    log(`${live.unverifiable}; plan: replace it with recovery-signed sequence ${sequence}`);
    if (live.claimed !== null && live.claimed >= sequence)
      log(
        `warning: ${LATEST_SIG} names sequence ${live.claimed}; Desktops that accepted that list keep it unless this list is above it or revokes its signers`
      );
  } else if (plan.kind === 'recover')
    log(
      `plan: sequence ${plan.liveSequence} -> ${sequence}, ${sequence < plan.liveSequence ? 'below live: ' : ''}it revokes ${plan.revokes.join(', ')}`
    );
  else log(`plan: sequence ${plan.liveSequence} -> ${sequence}`);
  log(`plan: write ${order.join(', ')}, then invalidate ${LATEST} and ${LATEST_SIG}`);
  if (deps.dryRun) return EXIT.ok;

  if (!(await putImmutable(store, versioned, candidate.manifest, log))) return EXIT.failed;
  if (!(await putImmutable(store, `${versioned}.sig`, candidate.sig, log))) return EXIT.failed;
  const lock = live.sigEtag ? { ifMatch: live.sigEtag } : ({ ifNoneMatch: '*' } as const);
  if ((await store.put(LATEST_SIG, candidate.sig, LATEST_CACHE_CONTROL, lock)) === 'conflict') {
    log(`${LATEST_SIG} changed since it was read: someone else published; nothing more was written`);
    return EXIT.failed;
  }
  log(`wrote ${LATEST_SIG}`);
  const jsonLock = live.jsonEtag ? { ifMatch: live.jsonEtag } : ({ ifNoneMatch: '*' } as const);
  if ((await store.put(LATEST, candidate.manifest, LATEST_CACHE_CONTROL, jsonLock)) === 'conflict') {
    log(`${LATEST} changed since it was read: someone else published; re-run once they finish`);
    return EXIT.failed;
  }
  log(`wrote ${LATEST}`);

  try {
    await store.invalidate([`/${LATEST}`, `/${LATEST_SIG}`]);
    log('invalidated the latest pair');
  } catch (error) {
    log(`warning: ${error instanceof Error ? error.message : 'invalidation failed'}; edges refresh within 5 minutes`);
  }
  if (deps.publicUrl) {
    try {
      const served: { sequence?: unknown } = await (await (deps.fetch ?? fetch)(deps.publicUrl)).json();
      log(`the CDN serves sequence ${String(served.sequence)}`);
    } catch {
      log('warning: could not read the list back through the CDN');
    }
  }
  log(`published sequence ${sequence}; if these bytes are not on main, commit them and the .sig in a sync PR`);
  return EXIT.ok;
}

export interface MainDeps {
  log?: (line: string) => void;
  readKeyring?: () => Promise<CuratedKey[]>;
  /** The bucket adapter; this branch ships none, so only --verify-only and an injected store run. */
  createStore?: (env: NodeJS.ProcessEnv) => PublishStore;
  fetch?: typeof fetch;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        manifest: { type: 'string' },
        sig: { type: 'string' },
        'verify-only': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }
  if (!values.manifest || !values.sig) {
    log('usage: curated:publish --manifest <path> --sig <path> [--verify-only] [--dry-run]');
    return EXIT.usage;
  }
  try {
    const [manifest, sig] = await Promise.all([
      readFile(cliPath(values.manifest, env)),
      readFile(cliPath(values.sig, env)),
    ]);
    const keyring = await (deps.readKeyring ?? readMainKeyring)();
    const checked = verifyCandidate(new Uint8Array(manifest), new Uint8Array(sig), keyring);
    if (!checked.ok) {
      log(`refused: ${checked.error}`);
      return EXIT.failed;
    }
    const signers = checked.value.signers.map(key => `${key.keyId} (${key.role})`).join(', ');
    log(`verified sequence ${checked.value.catalog.sequence}, signed by ${signers}`);
    if (values['verify-only']) return EXIT.ok;
    if (!deps.createStore) {
      log('uploading is not wired in this script yet; only --verify-only runs');
      return EXIT.usage;
    }
    return await publishCandidate(checked.value, {
      store: deps.createStore(env),
      keyring,
      log,
      dryRun: values['dry-run'],
      publicUrl: env.CURATED_PUBLIC_URL || undefined,
      fetch: deps.fetch,
    });
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
}

if (isEntry(import.meta.url)) main(process.argv.slice(2), process.env).then(code => (process.exitCode = code));
