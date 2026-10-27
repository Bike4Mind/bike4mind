/**
 * Release gate for a built Desktop app: the public test key must not be in it, and the baked list URL must be
 * empty or https.
 *
 *   B4M_CURATED_MANIFEST_URL=... pnpm --filter @bike4mind/scripts curated:check-build apps/desktop/out
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cliPath, isEntry } from './cli';
import { CURATED_DEV_SEED_TEXT, curatedDevKey } from './devKey';

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

/** Every file under `dir` that holds the test seed, its key id or its public key, by path relative to `dir`. */
export async function findDevKey(dir: string): Promise<BuildFinding[]> {
  const dev = curatedDevKey();
  const markers = { 'test key seed': CURATED_DEV_SEED_TEXT, 'test key id': dev.keyId, 'test public key': dev.spki };
  const findings: BuildFinding[] = [];
  for await (const file of files(dir)) {
    const bytes = await readFile(file);
    for (const [marker, text] of Object.entries(markers))
      if (bytes.includes(text)) findings.push({ file: path.relative(dir, file), marker });
  }
  return findings;
}

/** Null when the URL a release bakes in is acceptable: unset (remote list off) or an https URL. */
export function manifestUrlProblem(raw: string | undefined): string | null {
  if (!raw) return null;
  return URL.canParse(raw) && new URL(raw).protocol === 'https:' ? null : 'B4M_CURATED_MANIFEST_URL must be https';
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log = console.log): Promise<number> {
  if (argv.length !== 1) {
    log('usage: curated:check-build <built app dir>');
    return 2;
  }
  const findings = await findDevKey(cliPath(argv[0], env));
  for (const finding of findings) log(`${finding.file}: contains the curated ${finding.marker}`);
  const urlProblem = manifestUrlProblem(env.B4M_CURATED_MANIFEST_URL?.trim());
  if (urlProblem) log(urlProblem);
  if (findings.length > 0 || urlProblem) return 1;
  log('no curated test key in the build, and the list URL is acceptable');
  return 0;
}

if (isEntry(import.meta.url)) main(process.argv.slice(2), process.env).then(code => (process.exitCode = code));
