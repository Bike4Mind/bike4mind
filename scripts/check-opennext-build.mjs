#!/usr/bin/env node

// Runs the OpenNext build that sst.aws.Nextjs runs for apps/client, then fails if
// any Lambda bundle it emits is over Lambda's 250 MiB unzipped limit.
//
// A deploy is otherwise the first thing to run this build, inside `sst deploy`,
// after every infra resource the Nextjs component depends on has been created.
// `next build` reads no `Resource.*` value, so it needs no SST_RESOURCE_* env and
// no AWS credentials, and runs here without a stage.
//
// The command is the default sst 4.17.1 picks when infra/web.ts sets no
// `buildCommand` (normalizeBuildCommand in platform/src/components/aws/nextjs.ts),
// and the version is read from infra/web.ts so the two cannot drift.
//
// Env a deploy sets that this build does not mirror: ENABLE_SOURCE_MAPS only turns on
// browser source maps (static assets, not a Lambda bundle), and the *_BUCKET_NAME vars
// only feed images.remotePatterns hostnames in next.config.mjs. Neither moves the
// Lambda bundle sizes this script checks.
//
// Usage: pnpm turbo:core:build && node scripts/check-opennext-build.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'apps/client');

export const LAMBDA_UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024;

const OPEN_NEXT_VERSION_PATTERN = /\bopenNextVersion:\s*(['"`])([^'"`\n]+)\1/g;

export function parseOpenNextVersion(source) {
  const versions = [...source.matchAll(OPEN_NEXT_VERSION_PATTERN)].map(match => match[2]);
  if (versions.length !== 1) {
    throw new Error(
      `Expected exactly one string-literal \`openNextVersion: '<x.y.z>'\` in infra/web.ts, found ${versions.length}. ` +
        'If the pin moved (e.g. into a constant), update OPEN_NEXT_VERSION_PATTERN in scripts/check-opennext-build.mjs.'
    );
  }
  return versions[0];
}

// Numeric segments only: openNextBuildCommand validates x.y.z before calling this.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function openNextBuildCommand(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`openNextVersion "${version}" is not an exact x.y.z version.`);
  }
  const packageName = compareVersions(version, '3.1.3') <= 0 ? 'open-next' : '@opennextjs/aws';
  return `npx --yes ${packageName}@${version} build`;
}

// Mirrors what sst 4.17.1 zips (Function createZipAsset in
// platform/src/components/aws/function.ts): glob("**") without `follow`, then archiver
// (6.0.1) lstat()s each match and stores every symlink as a link entry, so a symlinked
// directory adds nothing to the unzipped size. A symlinked file is counted here at its
// target's size, which can only over-report against that zip: the guard may fail a
// bundle that would fit, never pass one that would not.
// Directory and dangling links are skipped and reported so a mostly-link bundle cannot
// read as small without anyone noticing.
export function bundleSize(dir) {
  let bytes = 0;
  let files = 0;
  let directoryLinks = 0;
  let brokenLinks = 0;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (stat?.isFile()) {
          bytes += stat.size;
          files++;
        } else if (!stat) {
          brokenLinks++;
        } else if (stat.isDirectory()) {
          directoryLinks++;
        }
      }
    }
  };
  walk(dir);
  return { bytes, files, directoryLinks, brokenLinks };
}

export function lambdaBundles(output) {
  const bundles = [];
  for (const [name, origin] of Object.entries(output.origins ?? {})) {
    if (origin?.bundle) bundles.push({ name, bundle: origin.bundle });
  }
  for (const [name, fn] of Object.entries(output.additionalProps ?? {})) {
    if (fn?.bundle) bundles.push({ name, bundle: fn.bundle });
  }
  return bundles;
}

export function hasDefaultBundle(bundles) {
  return bundles.some(({ name }) => name === 'default');
}

// `sizes` is [{ name, bytes }]. The limit is inclusive: a bundle of exactly `limit` bytes fits.
export function findOversized(sizes, limit = LAMBDA_UNZIPPED_LIMIT_BYTES) {
  return sizes.filter(({ bytes }) => bytes > limit);
}

const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// Returns the process exit code so every outcome leaves through the one exit below.
function main() {
  const version = parseOpenNextVersion(fs.readFileSync(path.join(repoRoot, 'infra/web.ts'), 'utf8'));
  const command = openNextBuildCommand(version);

  fs.rmSync(path.join(appDir, '.open-next'), { recursive: true, force: true });

  console.log(`Running in apps/client: ${command}`);
  const started = Date.now();
  const result = spawnSync(command, {
    cwd: appDir,
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      SST: '1',
      CI: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: '--max-old-space-size=12288',
      // A deploy sets this from the router URL, which does not exist before the
      // stage does. Any absolute URL exercises the same next.config.mjs path.
      NEXT_PUBLIC_CDN_URL: 'https://cdn.example.invalid',
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (result.status !== 0) {
    console.error(`\nERROR: OpenNext build failed after ${elapsed}s (exit ${result.status ?? result.signal}).`);
    return 1;
  }
  console.log(`\nOpenNext build finished in ${elapsed}s`);

  const outputFile = path.join(appDir, '.open-next/open-next.output.json');
  const bundles = lambdaBundles(JSON.parse(fs.readFileSync(outputFile, 'utf8')));
  if (!hasDefaultBundle(bundles)) {
    console.error('ERROR: open-next.output.json lists no default server function bundle.');
    return 1;
  }

  const sizes = bundles.map(({ name, bundle }) => ({
    name,
    bundle,
    ...bundleSize(path.join(appDir, bundle)),
  }));
  const oversized = findOversized(sizes);
  for (const size of sizes) {
    const { name, bundle, bytes, files, directoryLinks, brokenLinks } = size;
    const flag = oversized.includes(size) ? 'OVER ' : 'ok   ';
    console.log(
      `${flag} ${name.padEnd(24)} ${mib(bytes).padStart(10)}  ${files} files, ${directoryLinks} dir links skipped, ${brokenLinks} broken links  ${bundle}`
    );
  }

  if (oversized.length) {
    console.error(
      `\nERROR: ${oversized.length} bundle(s) exceed Lambda's ${mib(LAMBDA_UNZIPPED_LIMIT_BYTES)} unzipped limit, so the deploy would fail to create the function.`
    );
    return 1;
  }
  console.log(`\nOK: every bundle is under ${mib(LAMBDA_UNZIPPED_LIMIT_BYTES)} unzipped`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let exitCode;
  try {
    exitCode = main();
  } catch (error) {
    console.error(error.message ?? error);
    exitCode = 1;
  }
  process.exit(exitCode);
}
