import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  AdminAuditLogModel,
  ErasureRecordModel,
  User,
  erasureRecordRepository,
  type IErasureRecord,
} from '@bike4mind/database';
import { erasureIdHash, erasureKeyId, erasurePseudonym } from '@bike4mind/server-utils/privacy/erasureHash';
import { reapplyErasure } from '@server/users/reapplyErasure';

type Log = (message: string) => void;
const noop: Log = () => undefined;

export const erasureRecordSchema = z.object({
  idHash: z.string().min(1),
  keyId: z.string().min(1),
  pseudonym: z.string().nullable(),
  erasedAt: z.coerce.date(),
  initiatedBy: z.enum(['admin', 'self', 'backfill']),
});

/** An export is the trust boundary: validate it rather than trusting the file. */
export const parseErasureExport = (json: string): IErasureRecord[] =>
  z.array(erasureRecordSchema).parse(JSON.parse(json));

/** Where the erasure records come from; target-database records are never the default. */
export type RecordsSource =
  { kind: 'uri'; uri: string; dbName?: string } | { kind: 'file'; file: string } | { kind: 'target' };

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};

/**
 * Splits a mongo uri into host and database, credentials dropped. Returns undefined unless the uri has
 * at most one `@` and, if it has one, that `@` comes before any `?`: userinfo holding a raw `@` or `?`
 * cannot be told from the host or the query, so nothing between the scheme and the credential `@` is
 * ever returned. The cost is a legitimate `@` in a query option, which must be written `%40`. After
 * that, userinfo outside the RFC 3986 userinfo set is refused too: the driver quotes a bad username and
 * connectDB logs it. After that, the query goes first and the last `@` ends the userinfo,.
 */
const USERINFO_OK = /^[A-Za-z0-9\-._~!$&'()*+,;=:%]*$/;

const parseMongoUri = (uri: string): { host: string; db: string } | undefined => {
  const m = /^mongodb(?:\+srv)?:\/\/(.*)$/.exec(uri);
  if (!m) return undefined;
  if (m[1].split('@').length > 2) return undefined;
  const userinfo = m[1].includes('@') ? m[1].slice(0, m[1].lastIndexOf('@')) : '';
  if (!USERINFO_OK.test(userinfo)) return undefined;
  const [rest, ...query] = m[1].split('?');
  if (!rest.includes('@') && query.join('?').includes('@')) return undefined;
  const [host, ...path] = rest.slice(rest.lastIndexOf('@') + 1).split('/');
  return { host, db: path.join('/') };
};

/** Database named in a mongo uri path (`mongodb://host/db?x=1`), if any. */
export const dbNameFromUri = (uri: string): string | undefined => parseMongoUri(uri)?.db || undefined;

/**
 * Pick exactly one records source from the command line. A typo or an empty `$OLD_URI` must fail
 * loudly: a source that quietly yields nothing reads as "the restore is clean".
 */
export function parseRecordsSource(argv: string[]): RecordsSource {
  const uri = flagValue(argv, '--records-uri');
  const file = flagValue(argv, '--records-file');
  const target = argv.includes('--from-target');
  if ([uri, file, target || undefined].filter(Boolean).length !== 1) {
    throw new Error('pass exactly one of --records-uri, --records-file or --from-target');
  }
  if (file) return { kind: 'file', file };
  if (target) return { kind: 'target' };
  const dbName = flagValue(argv, '--records-db') ?? dbNameFromUri(uri as string);
  if (!dbName) throw new Error('the records uri names no database: add it to the uri path or pass --records-db');
  return { kind: 'uri', uri: uri as string, dbName };
}

/** `host/database` of a mongo uri, credentials dropped: safe to print. */
export const describeMongoTarget = (uri: string): string => {
  const parsed = parseMongoUri(uri);
  return parsed ? `${parsed.host}/${parsed.db || '(no database)'}` : '(unparseable uri)';
};

/**
 * Refuse a uri this script cannot describe safely, before connecting and before the same-target guard
 * (which cannot match what it cannot parse). The message names the variable, never the uri.
 */
export function assertUriDescribable(uri: string, name: string): void {
  if (parseMongoUri(uri)) return;
  throw new Error(
    `${name} could not be parsed; percent-encode reserved characters in the username, password and options (@ as %40, ? as %3F)`
  );
}

/** What the operator prints on failure; a driver parse error quotes pieces of the uri, so it is replaced. */
export const describeFailure = (error: unknown): string =>
  error instanceof Error && error.name === 'MongoParseError'
    ? 'could not parse the mongo uri; percent-encode reserved characters in the username, password and options'
    : error instanceof Error
      ? error.message
      : String(error);

/** What the operator sees for the records source; the target line sits beside it. */
export const describeRecordsSource = (source: RecordsSource): string =>
  source.kind === 'uri'
    ? `${parseMongoUri(source.uri)?.host ?? '(unparseable uri)'}/${source.dbName}`
    : source.kind === 'file'
      ? `file ${source.file}`
      : 'the target database';

/**
 * A `--records-uri` naming the target's own host and database reads the restored cluster, which lacks
 * every erasure after the restore point and still looks like a clean run: refuse it.
 */
export function assertRecordsNotTarget(source: RecordsSource, targetUri: string): void {
  if (source.kind === 'uri' && describeRecordsSource(source) === describeMongoTarget(targetUri)) {
    throw new Error('--records-uri is the target database itself; use --from-target if its records survived');
  }
}

/** Streams the records collection of another cluster (the pre-restore one), validating each row. */
export async function* recordsFromCluster(uri: string, dbName: string): AsyncGenerator<IErasureRecord> {
  const conn = await mongoose.createConnection(uri, { dbName }).asPromise();
  try {
    const cursor = conn.collection(ErasureRecordModel.collection.name).find({}, { projection: { _id: 0 } });
    for await (const doc of cursor) yield erasureRecordSchema.parse(doc);
  } finally {
    await conn.close();
  }
}

export async function exportErasureRecords(records: AsyncIterable<IErasureRecord>, file: string): Promise<number> {
  const all: IErasureRecord[] = [];
  for await (const r of records) all.push({ ...r });
  await writeFile(file, JSON.stringify(all, null, 2));
  return all.length;
}

export interface ReapplyErasuresOptions {
  /** Erasure records from a source that outlived the restore (pre-restore cluster or an export). */
  records: AsyncIterable<IErasureRecord> | Iterable<IErasureRecord>;
  dryRun: boolean;
  /** Users scanned per query. */
  batchSize?: number;
  log?: Log;
}

export interface ReapplyErasuresResult {
  scanned: number;
  /** Users present in the target database whose id hash has an erasure record. */
  matched: number;
  /** Matches re-erased; 0 in a dry run. */
  reapplied: number;
  failed: number;
  /** Records hashed under a different key than the current one (a rotated JWT_SECRET): cannot be matched. */
  unmatchableKey: number;
  /** Records read from the source; 0 almost always means a wrong source, not a clean restore. */
  recordsLoaded: number;
  /** Records newly written into the target database so a later export or restore still has them. */
  imported: number;
  /** Non-personal organisations (by org id) whose owner was re-erased: they need a new owner. */
  ownerlessOrganizationIds: string[];
}

/** Non-zero when the run needs a human: a failed or partial re-erasure, an unmatchable key, or an empty source. */
export const reapplyExitCode = (r: ReapplyErasuresResult, { allowEmpty = false } = {}): number =>
  r.failed > 0 || r.unmatchableKey > 0 || (r.recordsLoaded === 0 && !allowEmpty) ? 1 : 0;

/** Label for output: the pseudonym when one was recorded, else a hash prefix. Never a raw id. */
const label = (r: IErasureRecord) => r.pseudonym?.slice(0, 12) ?? `hash:${r.idHash.slice(0, 12)}`;

/**
 * Re-erase every account in the target database that an erasure record says was erased. Pages users
 * by _id, hashes each id and looks it up among the records. Once an account is gone it no longer
 * matches, so a re-run does nothing (it does not retry a partial purge: those users are reported as
 * `failed` and need a manual follow-up). A dry run only counts and labels. A real run first copies
 * every usable record into the target database, so the erasures stay repeatable after the next restore.
 */
export async function reapplyErasures({
  records,
  dryRun,
  batchSize = 500,
  log = noop,
}: ReapplyErasuresOptions): Promise<ReapplyErasuresResult> {
  const currentKeyId = erasureKeyId();
  const byHash = new Map<string, IErasureRecord>();
  const result: ReapplyErasuresResult = {
    scanned: 0,
    matched: 0,
    reapplied: 0,
    failed: 0,
    unmatchableKey: 0,
    recordsLoaded: 0,
    imported: 0,
    ownerlessOrganizationIds: [],
  };
  for await (const record of records) {
    result.recordsLoaded += 1;
    if (record.keyId === currentKeyId) byHash.set(record.idHash, record);
    else result.unmatchableKey += 1;
  }
  if (!dryRun) result.imported = await erasureRecordRepository.importMany([...byHash.values()]);
  if (result.unmatchableKey) {
    log(`WARNING: ${result.unmatchableKey} record(s) were hashed under another key and cannot be matched`);
  }

  let after: mongoose.Types.ObjectId | undefined;
  while (true) {
    const batch = await User.collection
      .find(after ? { _id: { $gt: after } } : {}, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (batch.length === 0) break;
    after = batch[batch.length - 1]._id as mongoose.Types.ObjectId;
    for (const row of batch) {
      result.scanned += 1;
      const userId = String(row._id);
      const record = byHash.get(erasureIdHash(userId));
      if (!record) continue;
      result.matched += 1;
      if (dryRun) {
        log(`would re-erase ${label(record)} (erased ${record.erasedAt.toISOString()}, ${record.initiatedBy})`);
        continue;
      }
      // Helper messages name the raw id; print the label instead.
      const redact = (message: string) => message.split(userId).join(label(record));
      let loggedErrors = 0;
      try {
        const { ownedOrganizationIds } = await reapplyErasure(userId, {
          record,
          logger: {
            info: noop,
            warn: (message: string) => log(redact(message)),
            error: (message: string) => {
              loggedErrors += 1;
              log(redact(message));
            },
          },
        });
        result.ownerlessOrganizationIds.push(...ownedOrganizationIds);
        if (loggedErrors > 0) {
          // The row is gone, so a re-run cannot finish the purge: it needs a manual follow-up.
          result.failed += 1;
          log(`FAILED ${label(record)}: account row deleted, ${loggedErrors} purge step(s) failed (see above)`);
        } else {
          result.reapplied += 1;
          log(`re-erased ${label(record)}`);
        }
      } catch (error) {
        result.failed += 1;
        log(`FAILED ${label(record)}: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }
  return result;
}

const AUDIT_ERASURE_ACTIONS = { 'user.deleted': 'admin', 'user.deletion.completed': 'self' } as const;

export interface BackfillResult {
  /** Audit entries naming a user who no longer exists. */
  candidates: number;
  /** Records newly written; 0 in a dry run. */
  created: number;
}

/**
 * Build erasure records for accounts erased before records existed, from the admin audit entries of
 * the two erasure paths. Skips a target that still has a user row (not erased, or already restored).
 * Accounts erased through no audited path cannot be found.
 */
export async function backfillErasureRecords({
  dryRun,
  log = noop,
}: {
  dryRun: boolean;
  log?: Log;
}): Promise<BackfillResult> {
  const keyId = erasureKeyId();
  const found = new Map<string, IErasureRecord>();
  const cursor = AdminAuditLogModel.find({
    action: { $in: Object.keys(AUDIT_ERASURE_ACTIONS) },
    'target.kind': 'user',
  })
    .select({ action: 1, occurredAt: 1, 'target.id': 1 })
    .lean()
    .cursor();
  for await (const entry of cursor) {
    const targetId = entry.target.id;
    if (!mongoose.isValidObjectId(targetId) || (await User.exists({ _id: targetId }))) continue;
    const idHash = erasureIdHash(targetId);
    if (found.has(idHash)) continue;
    found.set(idHash, {
      idHash,
      keyId,
      pseudonym: erasurePseudonym(targetId),
      erasedAt: entry.occurredAt,
      initiatedBy: AUDIT_ERASURE_ACTIONS[entry.action as keyof typeof AUDIT_ERASURE_ACTIONS],
    });
  }
  const candidates = [...found.values()];
  log(`${candidates.length} erased account(s) found in the audit log`);
  const created = dryRun ? 0 : await erasureRecordRepository.importMany(candidates);
  return { candidates: candidates.length, created };
}
