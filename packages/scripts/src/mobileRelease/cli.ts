import { parseArgs } from 'node:util';
import { MinimumClientVersionsSchema } from '@bike4mind/common';
import { parseParityMatrix, trainBlockers, type ParityMatrix } from './parityMatrix';
import {
  MOBILE_CLIENT_NAMES,
  MOBILE_PLATFORMS,
  buildNumber,
  formatReleaseTag,
  formatTrainVersion,
  mobileMinimumErrors,
  parseReleaseBuild,
  parseReleaseTag,
  trainOf,
  trainVersionForDate,
  type MobilePlatform,
  type ReleaseBuild,
} from './versioning';

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readFile: (path: string) => string;
  now: () => Date;
};

export const USAGE = [
  'Usage: mobile-release <command> [options]',
  '  validate [--matrix <path>]',
  '      Check the parity matrix.',
  '  plan --platform <ios|android> (--tag <tag> | --version <YY.M.PATCH> [--rc <n>]) [--matrix <path>]',
  '      Print version=, build_number=, tag= and client_name= lines (for $GITHUB_OUTPUT); fail when the',
  '      parity matrix has a feature due by this train that is not green on the platform.',
  '  train-version [--date <YYYY-MM-DD>]',
  '      The .0 version of the train cut on that date (default: today, UTC).',
  '  check-minimums --minimums <json>',
  '      Check the mobile entries of a minimumClientVersions value.',
].join('\n');

const OPTIONS = {
  matrix: { type: 'string' },
  platform: { type: 'string' },
  tag: { type: 'string' },
  version: { type: 'string' },
  rc: { type: 'string' },
  date: { type: 'string' },
  minimums: { type: 'string' },
} as const;

type Options = { [K in keyof typeof OPTIONS]?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function loadMatrix(path: string, io: CliIo): ParityMatrix | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(io.readFile(path));
  } catch (error) {
    io.stderr(`Cannot read the parity matrix at ${path}: ${(error as Error).message}`);
    return undefined;
  }
  const parsed = parseParityMatrix(raw);
  if ('errors' in parsed) {
    io.stderr(`Invalid parity matrix at ${path}:`);
    parsed.errors.forEach(error => io.stderr(`  ${error}`));
    return undefined;
  }
  return parsed.matrix;
}

function validate(options: Options, io: CliIo, matrixPath: string): number {
  const matrix = loadMatrix(options.matrix ?? matrixPath, io);
  if (!matrix) return 1;
  io.stdout(`Parity matrix OK: ${matrix.features.length} features.`);
  return 0;
}

function resolveBuild(options: Options, io: CliIo): ReleaseBuild | undefined {
  if (options.tag !== undefined && options.version !== undefined) {
    io.stderr('Pass --tag or --version, not both.');
    return undefined;
  }
  if (options.tag !== undefined) {
    const build = parseReleaseTag(options.tag);
    if (!build)
      io.stderr(`Not a release tag: "${options.tag}" (expected mobile-vYY.M.PATCH or mobile-vYY.M.PATCH-rc.N)`);
    return build;
  }
  if (options.version !== undefined) {
    const build = parseReleaseBuild(options.version, options.rc);
    if (!build)
      io.stderr(`Not a train version and rc: "${options.version}", rc "${options.rc ?? ''}" (rc is 1-98 or empty)`);
    return build;
  }
  io.stderr('plan needs --tag or --version.');
  return undefined;
}

function plan(options: Options, io: CliIo, matrixPath: string): number {
  const platform = options.platform as MobilePlatform | undefined;
  if (!platform || !MOBILE_PLATFORMS.includes(platform)) {
    io.stderr(`plan needs --platform ${MOBILE_PLATFORMS.join(' or ')}.`);
    return 2;
  }
  const build = resolveBuild(options, io);
  if (!build) return 2;
  const matrix = loadMatrix(options.matrix ?? matrixPath, io);
  if (!matrix) return 1;

  const train = trainOf(build.version);
  const blockers = trainBlockers(matrix, platform, train);
  if (blockers.length > 0) {
    io.stderr(`Parity gate: ${blockers.length} feature(s) due by train ${train} are not green on ${platform}:`);
    blockers.forEach(feature =>
      io.stderr(`  ${feature.id} (train ${feature.train}, ${platform}: ${feature[platform]})`)
    );
    io.stderr('Ship them, or retarget them to a later train in the parity matrix.');
    return 1;
  }
  io.stderr(`Parity gate: every feature due by train ${train} is green on ${platform}.`);
  io.stdout(`version=${formatTrainVersion(build.version)}`);
  io.stdout(`build_number=${buildNumber(build)}`);
  io.stdout(`tag=${formatReleaseTag(build)}`);
  io.stdout(`client_name=${MOBILE_CLIENT_NAMES[platform]}`);
  return 0;
}

function trainVersion(options: Options, io: CliIo): number {
  let date = io.now();
  if (options.date !== undefined) {
    date = new Date(`${options.date}T00:00:00Z`);
    // Date rolls 2027-02-30 over into March, so the parsed date must round-trip.
    if (!DATE.test(options.date) || Number.isNaN(date.getTime()) || !date.toISOString().startsWith(options.date)) {
      io.stderr(`Not a date: "${options.date}" (expected YYYY-MM-DD)`);
      return 2;
    }
  }
  io.stdout(formatTrainVersion(trainVersionForDate(date)));
  return 0;
}

function checkMinimums(options: Options, io: CliIo): number {
  if (options.minimums === undefined) {
    io.stderr('check-minimums needs --minimums <json>.');
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(options.minimums);
  } catch (error) {
    io.stderr(`--minimums is not JSON: ${(error as Error).message}`);
    return 1;
  }
  const parsed = MinimumClientVersionsSchema.safeParse(raw);
  if (!parsed.success) {
    io.stderr('--minimums is not a valid minimumClientVersions value:');
    parsed.error.issues.forEach(issue => io.stderr(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`));
    return 1;
  }
  const errors = mobileMinimumErrors(parsed.data);
  errors.forEach(error => io.stderr(error));
  for (const platform of MOBILE_PLATFORMS) {
    const name = MOBILE_CLIENT_NAMES[platform];
    io.stdout(`${name}: ${Object.hasOwn(parsed.data, name) ? parsed.data[name] : 'not gated'}`);
  }
  return errors.length > 0 ? 1 : 0;
}

/** Runs one command and returns the exit code: 0 ok, 1 check failed, 2 bad usage. */
export function runCli(argv: readonly string[], io: CliIo, matrixPath: string): number {
  const [command, ...rest] = argv;
  let options: Options;
  try {
    options = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    io.stderr((error as Error).message);
    io.stderr(USAGE);
    return 2;
  }
  switch (command) {
    case 'validate':
      return validate(options, io, matrixPath);
    case 'plan':
      return plan(options, io, matrixPath);
    case 'train-version':
      return trainVersion(options, io);
    case 'check-minimums':
      return checkMinimums(options, io);
    default:
      io.stderr(USAGE);
      return 2;
  }
}
