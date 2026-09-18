import { escapeRegex } from '@bike4mind/utils/escapeRegex';

/**
 * Pure decision logic for the lake embedding-space drain (drain-lake-embedding-space.ts).
 *
 * The script's guards are the whole reason it is safe to point at a production lake, and every one
 * of them used to live inline in `main()` beside a Mongo connection and an SQS client - so none of
 * them could be exercised without a stage. That matters more here than for a read-only census: the
 * refusals bound a pass that DELETES passages, and the documented invocation collapses the exit
 * code (`sst shell` and `pnpm --filter` both report 1 for any non-zero), which makes the printed
 * STOP line the only signal an operator actually gets. An untested authoritative signal is exactly
 * what this module exists to remove.
 *
 * Everything here is a decision ABOUT rows and flags, never a read of them. The script keeps the
 * I/O and prints what these return.
 */

/** The rebuild door's own wave sizes, from b4m-core/services/src/dataLakeService/rebuildLakePassages.ts. */
export const DEFAULT_WAVE = 50;
export const MAX_WAVE = 200;

export type DrainTarget = {
  /** What goes in the queue message's `lakeId`, which is what the convergence kill switch reads.
   *  A registry lake's id is its slug; a DB lake's is its document _id, resolved at run time. */
  lakeIdKind: 'registry' | 'db';
  registryId?: string;
  tag: string;
  prefix: string;
  /** Owners measured against the population this run was authorized over. A file owned by anyone
   *  else means the unanchored prefix arm reached outside it, so the run aborts. */
  owners: string[];
};

/**
 * Either a value to carry on with, or an exit code to return - both carrying the lines to print.
 *
 * `ok: false` with `exitCode: 0` is a clean stop rather than a refusal (a dry run that did what it
 * was asked), which is why the code is part of the outcome instead of being inferred from it.
 */
export type Decided<T> = { ok: true; lines: string[]; value: T } | { ok: false; lines: string[]; exitCode: 0 | 1 | 2 };

/** 1 = usage or failure, 2 = a guard refused to proceed (nothing was written). */
const refuse = (exitCode: 0 | 1 | 2, ...lines: string[]): Decided<never> => ({ ok: false, lines, exitCode });
const proceed = <T>(value: T, ...lines: string[]): Decided<T> => ({ ok: true, lines, value });

export const str = (v: unknown) => String(v ?? '');

export type DrainFileRow = {
  _id: unknown;
  userId?: unknown;
  fileName?: string;
  embeddingModel?: string;
  vectorizedChunkCount?: number;
  isChunking?: boolean;
  chunked?: boolean;
  vectorized?: boolean;
  chunkRebuildRequestedAt?: unknown;
};

export type DrainArgs = {
  lake: string;
  execute: boolean;
  verify: boolean;
  limit?: number;
  expect?: number;
  wave: number;
};

/**
 * `--flag value` parsing, with every numeric flag validated here rather than where it is used.
 *
 * Two of those numbers reach a loop stride, and an unvalidated one fails in a way no output
 * distinguishes from success: `Number('abc')` is NaN, so the first `i < length` test is false and
 * the run enqueues nothing while reporting a clean finish, and `Number('0')` never advances `i` at
 * all - an endless sequence of empty waves against a live database. Refusing the flag is the only
 * outcome an operator can read.
 */
export function parseDrainArgs(args: { argv: readonly string[]; lakes: readonly string[] }): Decided<DrainArgs> {
  const { argv, lakes } = args;
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const usage = `usage: --lake <${lakes.join('|')}> [--execute --expect N] [--limit N] [--wave N] [--verify]`;

  // An unknown value and a missing one land in the same place on purpose: `--lake --execute` parses
  // as the string "--execute", and running unscoped against whatever that resolved to is the one
  // failure mode worth spending a usage line on.
  const lake = flag('lake');
  if (!lake || !lakes.includes(lake)) return refuse(1, usage);

  const execute = has('execute');
  const verify = has('verify');
  if (execute && verify) {
    // --verify returns before the write path, so this combination used to read the lake and
    // silently not perform the drain it was asked for.
    return refuse(1, 'STOP: --execute with --verify. --verify only reads, so the drain would not run.', usage);
  }

  const counts: Record<string, number | undefined> = {};
  for (const [name, allowZero] of [
    ['limit', false],
    ['expect', true],
    ['wave', false],
  ] as const) {
    const raw = flag(name);
    if (raw === undefined) continue;
    const n = Number(raw);
    // `--expect 0` is allowed because the dry run prints it as the command to run when the
    // population is already empty; a zero limit or wave has no reading that does anything.
    if (!Number.isInteger(n) || n < 0 || (n === 0 && !allowZero)) {
      return refuse(
        1,
        `STOP: --${name} ${JSON.stringify(raw)} is not a ${allowZero ? 'whole' : 'positive whole'} number.`
      );
    }
    counts[name] = n;
  }

  return proceed({
    lake,
    execute,
    verify,
    limit: counts.limit,
    expect: counts.expect,
    wave: Math.min(counts.wave ?? DEFAULT_WAVE, MAX_WAVE),
  });
}

/**
 * The platform-level refusals, before a single file is read.
 *
 * `scopedSettingsRows` is the non-obvious one: this script reads the platform `PauseLakeConvergence`
 * row only, so the existence of ANY scoped settings row means its pause check is incomplete and a
 * pause set at a narrower scope would not be seen. That is a refusal rather than a warning because
 * the kill switch is the only way to halt a drain once its messages are enqueued.
 */
export function checkPlatformGuards(args: {
  defaultModel: string;
  paused: unknown;
  scopedSettingsRows: number;
}): Decided<string> {
  const { defaultModel, paused, scopedSettingsRows } = args;
  if (!defaultModel) {
    return refuse(2, 'STOP: defaultEmbeddingModel has no row. Refusing to guess the target space.');
  }
  if (paused) {
    return refuse(
      2,
      `STOP: PauseLakeConvergence = ${JSON.stringify(paused)}, so the worker would drop every message ` +
        'this run enqueues and the files would sit reset and unsearchable.'
    );
  }
  if (scopedSettingsRows > 0) {
    return refuse(
      2,
      `STOP: ${scopedSettingsRows} scopedsettings row(s) exist, so this script's platform-only pause ` +
        'check is incomplete - a pause set at a narrower scope would not be seen here.'
    );
  }
  return proceed(defaultModel);
}

/**
 * The id the queue message carries, which is what the convergence kill switch matches on.
 *
 * A registry lake with no `registryId` used to fall through to the empty string, and an empty
 * `lakeId` is not a harmless label: it is what a per-lake pause would have to match, so the drain
 * would be unstoppable by the one control that exists for it.
 */
export function resolveLakeId(args: { target: DrainTarget; lakeRow: { _id: unknown } | null }): Decided<string> {
  const { target, lakeRow } = args;
  if (target.lakeIdKind === 'registry') {
    if (!target.registryId) {
      return refuse(
        2,
        `STOP: registry lake "${target.tag}" carries no registryId, so the queue message would ` +
          'name no lake and PauseLakeConvergence could not halt it.'
      );
    }
    return proceed(target.registryId);
  }
  if (!lakeRow) {
    return refuse(2, `STOP: no datalakes row carries datalakeTag ${target.tag}.`);
  }
  const id = str(lakeRow._id);
  if (!id) {
    return refuse(2, `STOP: the datalakes row for ${target.tag} has no _id.`);
  }
  return proceed(id);
}

/**
 * Membership: the lake meta-tag OR the file tag prefix, with NO creator anchor on the prefix arm.
 *
 * Wider than `buildDataLakeMembershipQuery` on purpose (see the script docblock); the owner
 * allowlist is what bounds the widening. `tags` is an array of OBJECTS carrying a name, and
 * `deletedAt` is explicit because a lean/raw read bypasses the soft-delete find hook.
 */
export function buildDrainMembershipQuery(target: DrainTarget): Record<string, unknown> {
  return {
    deletedAt: null,
    $or: [
      { tags: { $elemMatch: { name: target.tag } } },
      { tags: { $elemMatch: { name: { $regex: `^${escapeRegex(target.prefix)}` } } } },
    ],
  };
}

export type OwnerAudit = {
  /** The per-owner census, printed whether or not it refuses. */
  lines: string[];
  unauthorized: string[];
  /** null when every owner is authorized. */
  refusal: { lines: string[]; exitCode: 2 } | null;
};

/**
 * Who owns the files the unanchored prefix arm reached.
 *
 * The census prints either way, because "every owner is authorized" is the claim the run rests on
 * and an operator should see it hold rather than infer it from the absence of a STOP.
 */
export function auditOwners(args: { rows: readonly DrainFileRow[]; owners: readonly string[] }): OwnerAudit {
  const { rows, owners } = args;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = str(row.userId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const lines: string[] = [];
  const unauthorized: string[] = [];
  for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const known = owners.includes(id);
    if (!known) unauthorized.push(id);
    lines.push(`  owner ${id} x${n}${known ? '' : '   <-- NOT IN THE AUTHORIZED OWNER LIST'}`);
  }
  return {
    lines,
    unauthorized,
    refusal:
      unauthorized.length === 0
        ? null
        : {
            exitCode: 2,
            lines: [
              '',
              'STOP: the prefix arm reached files owned outside the authorized set. Re-measure and re-authorize.',
            ],
          },
  };
}

/**
 * The gate between measuring the population and writing to it.
 *
 * `--expect` is not a convenience: the dry run and the execute run are separate reads of a live
 * lake, and a population that moved between them means the operator is approving a different drain
 * than the one they read. A missing `--expect` fails here too, which is why the comparison is
 * against the raw value rather than a defaulted one.
 */
export function checkExpectedPopulation(args: {
  lake: string;
  execute: boolean;
  expect?: number;
  population: number;
}): Decided<'execute'> {
  const { lake, execute, expect, population } = args;
  if (!execute) {
    return refuse(0, `\ndry run: nothing written. To execute:\n  --lake ${lake} --execute --expect ${population}`);
  }
  if (expect !== population) {
    return refuse(
      2,
      `\nSTOP: --expect ${expect ?? '(absent)'} does not match the measured population ${population}.`,
      'Pass the number the dry run printed, so a drifted population aborts instead of draining.'
    );
  }
  return proceed('execute');
}

/** `--limit` applied, then sliced into waves. A stride of 0 or NaN cannot reach here; see parseDrainArgs. */
export function planWaves(args: { ids: readonly string[]; limit?: number; wave: number }): string[][] {
  const { ids, limit, wave } = args;
  if (!Number.isInteger(wave) || wave <= 0) {
    throw new Error(`Refusing to plan waves of ${wave}: a non-positive stride never terminates.`);
  }
  const ordered = ids.slice(0, limit ?? ids.length);
  const waves: string[][] = [];
  for (let i = 0; i < ordered.length; i += wave) waves.push(ordered.slice(i, i + wave));
  return waves;
}

/**
 * The convergence verdict.
 *
 * Both counts, never one: the file's own label is a STAMP and not its vectors, so a lake can read
 * all-converged at the file level while its passages still hold the old space - a drain of this
 * lake once showed every file reading vectorized:true with 72% of their passages holding no vector
 * at all. The second number is what retrieval actually scores against.
 */
export function verifyVerdict(args: { defaultModel: string; staleFiles: number; staleChunks: number }): {
  lines: string[];
  exitCode: 0 | 2;
} {
  const { defaultModel, staleFiles, staleChunks } = args;
  return {
    lines: [
      `\n  files not in ${defaultModel}:    ${staleFiles}`,
      `  passages not in ${defaultModel}: ${staleChunks}`,
      '  DRAIN IS COMPLETE WHEN BOTH ARE 0. A zero on the first line alone is a stamp,',
      '  not a re-embed, and the second line is what retrieval actually scores against.',
    ],
    exitCode: staleFiles === 0 && staleChunks === 0 ? 0 : 2,
  };
}

/** "value xN" counts, commonest first. */
export function tally(rows: readonly DrainFileRow[], key: (f: DrainFileRow) => string): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');
}
