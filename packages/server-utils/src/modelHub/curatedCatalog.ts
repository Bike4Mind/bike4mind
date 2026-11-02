import { CuratedCatalogSchema, parseHubManifest, type HubManifest } from '@bike4mind/common';
import {
  curatedCatalogVersionRepository,
  withTransaction,
  type CuratedCatalogVersionRecord,
  type CuratedCatalogVersionRepository,
  type CuratedVersionOrigin,
} from '@bike4mind/database';
import {
  CURATED_MAX_MANIFEST_BYTES,
  CURATED_MAX_SEQUENCE,
  CURATED_MAX_SIGNATURE_BYTES,
  PRODUCTION_CURATED_KEYS,
  isCuratedListable,
  parseCuratedSignatureFile,
  verifyCurated,
  type CuratedKey,
} from '@bike4mind/local-models/curated-signing';
import { curatedDevKeys } from './curatedDevKeys';

export const CURATED_CHANNEL = 'curated-v2';
/** Same cap as packages/scripts curatedCatalog/catalogChecks.ts MAX_SEQUENCE_STEP; a first import counts from 0. */
export const CURATED_MAX_SEQUENCE_STEP = 1000;

export const CURATED_LATEST_CACHE_CONTROL = 'public, max-age=300';
export const CURATED_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const CURATED_SCHEMA_CACHE_CONTROL = 'public, max-age=3600';

const PREVIEW_STAGE = /^pr\d+$/;

/**
 * The public test keys are trusted only with MODEL_HUB_CURATED_DEV_KEYS=1, never on production, and on a deployed
 * stage only when it is a preview, so a local, self-hosted or preview app can take a list the dev builds of Desktop
 * and the CLI accept. `deployed` is isDeployedStage() from utils/config.
 */
export function curatedDevKeysEnabled(
  env: Record<string, string | undefined>,
  stage: string | undefined,
  deployed: boolean
): boolean {
  if (env.MODEL_HUB_CURATED_DEV_KEYS !== '1' || stage === 'production') return false;
  return !deployed || PREVIEW_STAGE.test(stage ?? '');
}

/** catalog/model-hub/keys.json as compiled into this build, plus the test keys when enabled. */
export function curatedServerKeyring(devKeys: boolean): CuratedKey[] {
  return [...PRODUCTION_CURATED_KEYS, ...(devKeys ? curatedDevKeys() : [])];
}

export type CuratedFile =
  | { kind: 'schema' }
  | { kind: 'latest'; signature: boolean }
  | { kind: 'sequence'; sequence: number; signature: boolean };

/** `latest.json`, `<sequence>.json`, either with `.sig`, or `schema.json`; null for any other name. */
export function parseCuratedFileName(name: string): CuratedFile | null {
  if (name === 'schema.json') return { kind: 'schema' };
  const match = /^(latest|[1-9]\d{0,6})\.json(\.sig)?$/.exec(name);
  if (!match) return null;
  const signature = match[2] !== undefined;
  if (match[1] === 'latest') return { kind: 'latest', signature };
  const sequence = Number(match[1]);
  return sequence <= CURATED_MAX_SEQUENCE ? { kind: 'sequence', sequence, signature } : null;
}

export interface CuratedImportInput {
  manifest: string;
  signature: string;
  origin: CuratedVersionOrigin;
  publishedBy: string | null;
  reason: string | null;
}

/** 409: the sequence is not above live or is taken; 400: anything else about the pair. */
export type CuratedImportRefusal = { ok: false; status: 400 | 409; error: string };

/**
 * `first`, `next` (above live) or `recover`: recovery-signed and revoking every key that signed live, so it replaces
 * live at any unused sequence, as planPublish in packages/scripts curatedCatalog/catalogChecks.ts allows.
 */
export type CuratedImportPlan = 'first' | 'next' | 'recover' | 'already-live';

export type CuratedImportResult =
  | {
      ok: true;
      alreadyLive: false;
      plan: Exclude<CuratedImportPlan, 'already-live'>;
      version: CuratedCatalogVersionRecord;
      live: CuratedCatalogVersionRecord | null;
    }
  | { ok: true; alreadyLive: true; version: CuratedCatalogVersionRecord }
  | CuratedImportRefusal;

export interface LiveList {
  record: CuratedCatalogVersionRecord;
  manifest: HubManifest;
  recoverySigned: boolean;
}

const utf8 = (text: string) => Buffer.from(text, 'utf8');
// A lone surrogate would be stored as one string but hashed and served as U+FFFD.
const wellFormed = (text: string) => utf8(text).toString('utf8') === text;
const refuse = (error: string, status: 400 | 409 = 400): CuratedImportRefusal => ({ ok: false, status, error });

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

const recoveryCheck = (keyring: readonly CuratedKey[]) => (id: string) =>
  keyring.some(key => key.keyId === id && key.role === 'recovery');

export function readLive(record: CuratedCatalogVersionRecord | null, keyring: readonly CuratedKey[]): LiveList | null {
  if (!record) return null;
  const { manifest } = parseHubManifest(JSON.parse(record.manifestBytes));
  return { record, manifest, recoverySigned: record.keyIds.some(recoveryCheck(keyring)) };
}

/**
 * The checks a signed pair passes before it is stored, in planPublish's order: the pair verifies under `keyring` (minus
 * keys a recovery-signed live list revoked), the strict catalog schema holds, clients would drop nothing, every pick
 * can fill its slot, revocations carry a recovery signature, and unless it is a recovery, the sequence is above live
 * with an append-only changelog and revocation set. Only a recovery-signed live list's revocations bind.
 */
export function checkCuratedImport(
  manifest: string,
  signature: string,
  keyring: readonly CuratedKey[],
  live: LiveList | null
): { ok: true; plan: CuratedImportPlan; sequence: number; keyIds: string[] } | CuratedImportRefusal {
  if (!wellFormed(manifest) || !wellFormed(signature)) return refuse('the pair is not well-formed UTF-8 text');
  const manifestBytes = utf8(manifest);
  const signatureBytes = utf8(signature);
  if (manifestBytes.byteLength > CURATED_MAX_MANIFEST_BYTES)
    return refuse(`the list is over ${CURATED_MAX_MANIFEST_BYTES} bytes`);
  if (signatureBytes.byteLength > CURATED_MAX_SIGNATURE_BYTES)
    return refuse(`the signature file is over ${CURATED_MAX_SIGNATURE_BYTES} bytes`);

  const revoked = new Set(live?.recoverySigned ? live.manifest.revokedKeyIds : []);
  const verified = verifyCurated(manifestBytes, signatureBytes, keyring, revoked);
  if (!verified.ok) return refuse(`${verified.reason}: ${verified.detail}`);

  let raw: unknown;
  try {
    raw = JSON.parse(manifest);
  } catch {
    return refuse('the list is not JSON');
  }
  const strict = CuratedCatalogSchema.safeParse(raw);
  if (!strict.success) return refuse(`the list fails the catalog schema: ${issues(strict.error)}`);
  const { dropped } = parseHubManifest(raw);
  if (dropped.length > 0)
    return refuse(`clients would drop part of the list: ${dropped.map(d => `${d.path} (${d.reason})`).join('; ')}`);
  const next = strict.data as HubManifest & { sequence: number };
  const sequence = next.sequence;
  if (parseCuratedSignatureFile(signatureBytes)?.sequence !== sequence)
    return refuse(`the signature file must name sequence ${sequence}`);
  const keyIds = verified.keys.map(key => key.keyId);
  if (live && manifest === live.record.manifestBytes && signature === live.record.signatureBytes)
    return { ok: true, plan: 'already-live', sequence, keyIds };

  // Same rule as the bucket publish (catalogChecks.ts verifyCandidate), so both paths refuse the same lists.
  for (const tier of next.tiers)
    for (const pick of tier.picks) {
      const entry = next.entries.find(candidate => candidate.id === pick.entry);
      if (entry && !isCuratedListable(entry, next))
        return refuse(`${pick.entry} cannot fill the ${pick.slot} slot of a ${tier.memoryKind} tier`);
    }

  const isRecovery = recoveryCheck(keyring);
  const recoverySigned = verified.keys.some(key => key.role === 'recovery');
  const recoveryIds = next.revokedKeyIds.filter(isRecovery);
  if (recoveryIds.length > 0) return refuse(`revokedKeyIds names recovery key ${recoveryIds.join(', ')}`);
  if (next.revokedKeyIds.length > 0 && !recoverySigned)
    return refuse(`revokedKeyIds names ${next.revokedKeyIds.join(', ')}, so a recovery key must co-sign the list`);

  const liveSequence = live?.record.sequence ?? 0;
  // Mirrors CuratedListSource in b4m-core/local-models: a list signed only by keys this one revokes binds nothing.
  const recover =
    live !== null &&
    recoverySigned &&
    live.record.keyIds.every(id => !isRecovery(id) && next.revokedKeyIds.includes(id));
  if (live && sequence <= liveSequence) {
    if (recover) return { ok: true, plan: 'recover', sequence, keyIds };
    return refuse(`sequence ${sequence} is not above live sequence ${liveSequence}`, 409);
  }
  if (sequence - liveSequence > CURATED_MAX_SEQUENCE_STEP)
    return refuse(`sequence ${sequence} is more than ${CURATED_MAX_SEQUENCE_STEP} above live sequence ${liveSequence}`);
  if (!live) return { ok: true, plan: 'first', sequence, keyIds };
  if (recover) return { ok: true, plan: 'recover', sequence, keyIds };

  const current = live.manifest;
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt))
    return refuse(`updatedAt ${next.updatedAt} is earlier than live ${current.updatedAt}`);
  const kept = next.changelog.filter(item => item.sequence <= liveSequence);
  if (JSON.stringify(kept) !== JSON.stringify(current.changelog.slice(0, kept.length)))
    return refuse('changelog items already live were changed or removed; only prepend new ones');
  const missing = live.recoverySigned ? current.revokedKeyIds.filter(id => !next.revokedKeyIds.includes(id)) : [];
  if (missing.length > 0) return refuse(`revokedKeyIds drops ${missing.join(', ')}`);
  return { ok: true, plan: 'next', sequence, keyIds };
}

export interface CuratedImportDeps {
  repository?: CuratedCatalogVersionRepository;
  /** Runs the live read, the append and `onStored` as one unit; a Mongo transaction by default. */
  transact?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Runs inside that unit after the append (the audit entry); a throw undoes the append. */
  onStored?: (version: CuratedCatalogVersionRecord, live: CuratedCatalogVersionRecord | null) => Promise<void>;
}

class ImportConflict extends Error {
  constructor(readonly refusal: CuratedImportRefusal) {
    super(refusal.error);
  }
}

/** Verifies an already-signed pair against live and stores it as the next version in the chain, byte for byte. */
export async function importCuratedVersion(
  input: CuratedImportInput,
  keyring: readonly CuratedKey[],
  deps: CuratedImportDeps = {}
): Promise<CuratedImportResult> {
  const repository = deps.repository ?? curatedCatalogVersionRepository;
  const transact = deps.transact ?? (work => withTransaction(() => work()));
  await repository.ready();
  try {
    return await transact(async (): Promise<CuratedImportResult> => {
      const liveRecord = await repository.latest(CURATED_CHANNEL);
      const checked = checkCuratedImport(input.manifest, input.signature, keyring, readLive(liveRecord, keyring));
      if (!checked.ok) return checked;
      if (checked.plan === 'already-live') return { ok: true, alreadyLive: true, version: liveRecord! };
      if (await repository.findBySequence(CURATED_CHANNEL, checked.sequence))
        return refuse(`sequence ${checked.sequence} is already stored`, 409);
      const version = await repository.append({
        channel: CURATED_CHANNEL,
        sequence: checked.sequence,
        position: (liveRecord?.position ?? 0) + 1,
        manifestBytes: input.manifest,
        signatureBytes: input.signature,
        keyIds: checked.keyIds,
        origin: input.origin,
        publishedBy: input.publishedBy,
        reason: input.reason,
      });
      // Thrown, not returned: the failed insert has already aborted a surrounding transaction.
      if (!version) throw new ImportConflict(refuse('another list was published at the same time; retry', 409));
      await deps.onStored?.(version, liveRecord);
      return { ok: true, alreadyLive: false, plan: checked.plan, version, live: liveRecord };
    });
  } catch (error) {
    if (error instanceof ImportConflict) return error.refusal;
    throw error;
  }
}
