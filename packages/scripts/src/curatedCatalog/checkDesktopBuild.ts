/**
 * Release gate for a built Desktop app (`apps/desktop/out`) or CLI (`packages/cli/dist`): the public test keys must
 * not be in it, and the list URL it baked in must be empty or the expected https URL. Each `--also-scan` dir (the
 * externalized `@bike4mind/local-models` dist, which holds the keyring and ships from node_modules) gets the
 * test-key scan only. The release workflows run it between the build and packaging.
 *
 *   pnpm --filter @bike4mind/scripts curated:check-build apps/desktop/out [--expect-url <public list URL>]
 *     [--also-scan <dir>]...
 */
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cliPath, isEntry } from './cli';
import { CURATED_DEV_SEED_TEXTS, curatedDevKey } from './devKey';

// Written by the curatedBuildInfo plugin in apps/desktop/electron.vite.config.ts, and for the CLI by
// curatedBuildInfoPlugin in packages/cli/tsdown.config.ts (at the root of dist).
export const BUILD_INFO_PATH = path.join('main', 'curated-build.json');
export const CLI_BUILD_INFO_PATH = 'curated-build.json';

export interface BuildFinding {
  file: string;
  marker: string;
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

/** Every file under `dir` that holds a test seed, key id or public key, by path relative to `dir`. */
export async function findDevKey(dir: string): Promise<BuildFinding[]> {
  const markers: Record<string, string> = {};
  for (const role of ['signing', 'recovery'] as const) {
    const dev = curatedDevKey(role);
    markers[`${role} test key seed`] = CURATED_DEV_SEED_TEXTS[role];
    markers[`${role} test key id`] = dev.keyId;
    markers[`${role} test public key`] = dev.spki;
  }
  const findings: BuildFinding[] = [];
  for await (const file of files(dir)) {
    const bytes = await readFile(file);
    for (const [marker, text] of Object.entries(markers))
      if (bytes.includes(text)) findings.push({ file: path.relative(dir, file), marker });
  }
  return findings;
}

// A CLI build replaces these reads at build time; one that survives would let the environment override the baked value.
const RUNTIME_READS = ['process.env.B4M_CURATED_MANIFEST_URL', 'process.env.B4M_CURATED_DEV_KEYS'];

/** Every file under `dir` that still reads a baked curated variable from the environment. */
export async function findRuntimeReads(dir: string): Promise<BuildFinding[]> {
  const findings: BuildFinding[] = [];
  for await (const file of files(dir)) {
    const bytes = await readFile(file);
    for (const read of RUNTIME_READS)
      if (bytes.includes(read)) findings.push({ file: path.relative(dir, file), marker: read });
  }
  return findings;
}

const isCliBuild = (dir: string) =>
  access(path.join(dir, CLI_BUILD_INFO_PATH)).then(
    () => true,
    () => false
  );

/** Null when the URL a release bakes in is acceptable: unset (remote list off), or https and exactly `expected`. */
export function manifestUrlProblem(raw: string | undefined, expected?: string): string | null {
  if (!raw) return null;
  if (!URL.canParse(raw) || new URL(raw).protocol !== 'https:') return 'B4M_CURATED_MANIFEST_URL must be https';
  if (!expected) return 'B4M_CURATED_MANIFEST_URL is set but no --expect-url was given to compare it with';
  if (!URL.canParse(expected) || new URL(expected).href !== new URL(raw).href)
    return `B4M_CURATED_MANIFEST_URL is not the expected ${expected}`;
  return null;
}

/** The problems `curated-build.json` reports; a build without one cannot be checked, so that is one too. */
export async function buildInfoProblems(dir: string, expectedUrl?: string): Promise<string[]> {
  let info: { devKeys?: unknown; manifestUrl?: unknown } | undefined;
  let found = BUILD_INFO_PATH;
  for (const candidate of [BUILD_INFO_PATH, CLI_BUILD_INFO_PATH]) {
    try {
      info = JSON.parse(await readFile(path.join(dir, candidate), 'utf8'));
      found = candidate;
      break;
    } catch {
      info = undefined;
    }
  }
  if (info === undefined)
    return [`${BUILD_INFO_PATH} is missing or unreadable; is this an apps/desktop/out or packages/cli/dist build?`];
  if (typeof info !== 'object' || info === null || typeof info.manifestUrl !== 'string')
    return [`${found} is malformed`];
  const problems: string[] = [];
  if (info.devKeys !== false) problems.push('the build was made with B4M_CURATED_DEV_KEYS=1');
  const urlProblem = manifestUrlProblem(info.manifestUrl.trim(), expectedUrl?.trim());
  if (urlProblem) problems.push(`${urlProblem} (baked: ${info.manifestUrl})`);
  return problems;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log = console.log): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'expect-url': { type: 'string' }, 'also-scan': { type: 'string', multiple: true } },
    });
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.positionals.length !== 1) {
    log('usage: curated:check-build <built app dir> [--expect-url <public list URL>] [--also-scan <dir>]...');
    return 2;
  }
  const dir = cliPath(parsed.positionals[0], env);
  const findings = await findDevKey(dir);
  for (const finding of findings) log(`${finding.file}: contains the curated ${finding.marker}`);
  if (await isCliBuild(dir))
    for (const read of await findRuntimeReads(dir)) {
      findings.push(read);
      log(`${read.file}: still reads ${read.marker} at runtime`);
    }
  let scanFailed = false;
  for (const extra of parsed.values['also-scan'] ?? []) {
    const extraDir = cliPath(extra, env);
    try {
      for (const finding of await findDevKey(extraDir)) {
        findings.push(finding);
        log(`${path.join(extraDir, finding.file)}: contains the curated ${finding.marker}`);
      }
    } catch (error) {
      scanFailed = true;
      log(`${extraDir} cannot be scanned; was it built? (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const problems = await buildInfoProblems(dir, parsed.values['expect-url']);
  for (const problem of problems) log(problem);
  if (findings.length > 0 || problems.length > 0 || scanFailed) return 1;
  log('no curated test key in the build, and the list URL is acceptable');
  return 0;
}

if (isEntry(import.meta.url)) main(process.argv.slice(2), process.env).then(code => (process.exitCode = code));
