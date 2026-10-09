#!/usr/bin/env node

// Packs every published b4m-core package, installs the tarballs into a bare consumer project and runs tsc over
// each importable export with skipLibCheck off. The repo's own tsconfigs skip lib checking, so a name that dangles
// inside a generated dist declaration only breaks a consumer's build. The consumer is DOM-free (lib es2022 plus
// @types/node), so a dist that leans on DOM globals fails too.
//
// Usage: pnpm turbo:core:build && node scripts/check-published-dts.mjs   (KEEP_TMP=1 keeps the temp directory)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts', 'fixtures', 'dangling-dts');
const FIXTURE_PACKAGE = '@bike4mind-fixture/dangling';
const OTHER_GROUP = 'other (not a @bike4mind package)';
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

// Shared by the real check and the self-test, so the self-test proves the exact options the real check runs with.
const COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  types: ['node'],
  target: 'es2022',
  lib: ['es2022'],
};

const CONFIGS = [
  {
    name: 'bundler',
    options: { module: 'esnext', moduleResolution: 'bundler' },
    entries: ['esm.mts'],
  },
  {
    name: 'nodenext',
    options: { module: 'nodenext', moduleResolution: 'nodenext' },
    entries: ['esm.mts', 'cjs.cts'],
  },
];

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const label = `${command} ${args.slice(0, 2).join(' ')}`;
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})\n${result.stderr}${result.stdout}`);
  }
  return result.stdout;
}

// Versions of typescript and @types/node installed in the repo, pinned so the consumer type-checks with the same compiler.
function installedPins() {
  const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
  return ['typescript', '@types/node'].map(name => `${name}@${requireFromRoot(`${name}/package.json`).version}`);
}

// Messages for every packed @bike4mind entry in the consumer's lockfile (nested copies included) that npm resolved from
// anywhere but a local tarball.
export function nonTarballResolutions(lockPackages, packedNames) {
  return Object.entries(lockPackages).flatMap(([key, entry]) => {
    const name = /(?:^|\/)node_modules\/(@bike4mind\/[^/]+)$/.exec(key)?.[1];
    if (!name || !packedNames.includes(name) || entry.resolved?.startsWith('file:')) return [];
    return [`npm resolved ${name} from ${entry.resolved ?? '(no resolved field)'}, not the packed tarball`];
  });
}

function hasTypes(target) {
  if (typeof target === 'string') return DECLARATION_FILE.test(target);
  if (Array.isArray(target)) return target.some(hasTypes);
  if (target && typeof target === 'object') {
    return Object.entries(target).some(
      ([condition, value]) => (condition === 'types' && typeof value === 'string') || hasTypes(value)
    );
  }
  return false;
}

// Subpaths of an exports field that can be imported by name and resolve a declaration file.
export function exportSubpaths(exportsField) {
  if (exportsField == null) return [];
  const isSubpathMap =
    typeof exportsField === 'object' &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).every(key => key.startsWith('.'));
  const subpathMap = isSubpathMap ? exportsField : { '.': exportsField };
  return Object.entries(subpathMap)
    .filter(([key, target]) => key !== './package.json' && !key.includes('*') && hasTypes(target))
    .map(([key]) => key);
}

// tsc error blocks (the error line plus its indented continuation lines) keyed by the @bike4mind package whose
// dist they point into; the same error reported by both configs collapses to one entry.
export function groupTscErrors(output) {
  const blocks = [];
  for (const line of output.split('\n')) {
    if (/(?:^| )error TS\d+: /.test(line)) blocks.push([line]);
    else if (blocks.length > 0 && /^\s+\S/.test(line)) blocks[blocks.length - 1].push(line);
  }
  const groups = new Map();
  for (const block of blocks) {
    const owner = /^node_modules\/(@bike4mind\/[^/]+)\//.exec(block[0])?.[1] ?? OTHER_GROUP;
    if (!groups.has(owner)) groups.set(owner, new Set());
    groups.get(owner).add(block.join('\n'));
  }
  return groups;
}

export function discoverPackages(root = repoRoot) {
  const coreDir = path.join(root, 'b4m-core');
  const packages = [];
  for (const name of fs.readdirSync(coreDir).sort()) {
    const dir = path.join(coreDir, name);
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.private === true) continue;
    packages.push({ dir, name, packageName: manifest.name, version: manifest.version });
  }
  if (packages.length === 0) throw new Error('no published packages found under b4m-core');
  const unbuilt = packages.filter(pkg => !fs.existsSync(path.join(pkg.dir, 'dist')));
  if (unbuilt.length > 0) {
    throw new Error(
      `no dist/ in b4m-core/{${unbuilt.map(pkg => pkg.name).join(',')}}; run pnpm turbo:core:build first`
    );
  }
  return packages;
}

function packAll(packages, tarballDir) {
  fs.mkdirSync(tarballDir, { recursive: true });
  for (const pkg of packages) run('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: pkg.dir });
  const tarballs = fs
    .readdirSync(tarballDir)
    .filter(file => file.endsWith('.tgz'))
    .sort()
    .map(file => path.join(tarballDir, file));
  if (tarballs.length !== packages.length) {
    throw new Error(`packed ${tarballs.length} tarballs for ${packages.length} packages`);
  }
  return tarballs;
}

function installConsumer(consumerDir, tarballs, pins) {
  fs.mkdirSync(consumerDir, { recursive: true });
  writeJson(path.join(consumerDir, 'package.json'), { private: true, type: 'module' });
  // No package here emits declarations at install time; skipping scripts removes native-build failure modes.
  const args = ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs, ...pins];
  run('npm', args, { cwd: consumerDir });
}

function assertInstalledFromTarballs(consumerDir, packages) {
  const lock = readJson(path.join(consumerDir, 'package-lock.json'));
  const problems = nonTarballResolutions(
    lock.packages ?? {},
    packages.map(pkg => pkg.packageName)
  );
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function writeTsconfigs(consumerDir) {
  for (const { name, options, entries } of CONFIGS) {
    const compilerOptions = { ...COMPILER_OPTIONS, ...options };
    const selfTestEntries = entries.map(entry => entry.replace(/^(?:esm|cjs)\./, 'selftest.'));
    writeJson(path.join(consumerDir, `tsconfig.${name}.json`), { compilerOptions, include: entries });
    writeJson(path.join(consumerDir, `tsconfig.selftest-${name}.json`), { compilerOptions, include: selfTestEntries });
  }
}

function typecheck(consumerDir, project, extraArgs = []) {
  const tsc = path.join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--pretty', 'false', ...extraArgs], {
    cwd: consumerDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const killed = result.signal ? `tsc killed by ${result.signal}\n` : '';
  return { status: result.status, signal: result.signal, output: `${killed}${result.stdout}${result.stderr}` };
}

// `tsc --listFiles` prints one absolute path per line after the diagnostics.
export function splitTscOutput(output) {
  const listing = [];
  const diagnostics = [];
  for (const line of output.split('\n')) {
    (/^(?:\/|[A-Za-z]:[\\/])/.test(line) && !line.includes('error TS') ? listing : diagnostics).push(line);
  }
  return { listing: listing.join('\n'), diagnostics: diagnostics.join('\n') };
}

// DOM-style lib files (dom, webworker, and their variants) in a file listing; any hit means the consumer program
// is not DOM-free.
export function domLibFiles(listing) {
  return listing.split('\n').filter(line => /(?:^|[\\/])lib\.(?:dom|webworker)[\w.]*\.d\.ts$/.test(line.trim()));
}

// The fixture declaration each consumer entry resolves to (esm.mts -> index.d.mts, cjs.cts -> index.d.cts).
export const fixtureDeclarations = entries => entries.map(entry => `index.d${path.extname(entry)}`);

// Null when the fixture failed for both expected reasons (a dangling name, and the DOM-only Document that proves the
// consumer is DOM-free); otherwise why the self-test cannot be trusted.
export function selfTestVerdict(status, output, declarations = ['index.d.mts']) {
  if (status === 0) return 'self-test passed unexpectedly: lib checking is not active';
  for (const declaration of declarations) {
    const named = output.split('\n').some(line => line.includes(`${declaration}(`) && line.includes('ns$1'));
    if (!named) return `self-test failed without naming ns$1 in ${declaration}\n${output}`;
  }
  if (!/error TS2304: Cannot find name 'Document'/.test(output)) {
    return 'self-test: DOM types are present in the consumer (lib or a /// <reference lib="dom"> leaked them in); DOM leaks from our packages would pass';
  }
  return null;
}

// The fixture's declarations dangle on purpose: if tsc passes them, lib checking is off or DOM types leaked in, and the
// real result means nothing.
function selfTest(consumerDir) {
  const installed = path.join(consumerDir, 'node_modules', FIXTURE_PACKAGE);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.cpSync(fixtureDir, installed, { recursive: true });
  fs.writeFileSync(
    path.join(consumerDir, 'selftest.mts'),
    `import * as f from '${FIXTURE_PACKAGE}';\nvoid f;\nexport {};\n`
  );
  fs.writeFileSync(
    path.join(consumerDir, 'selftest.cts'),
    `import f = require('${FIXTURE_PACKAGE}');\nvoid f;\nexport {};\n`
  );
  for (const { name, entries } of CONFIGS) {
    const { status, output } = typecheck(consumerDir, `tsconfig.selftest-${name}.json`);
    const verdict = selfTestVerdict(status, output, fixtureDeclarations(entries));
    // The config tag goes on the headline, ahead of any tsc output that follows it.
    if (verdict) throw new Error(verdict.replace(/\n|$/, ` (${name} config)$&`));
  }
}

// Import specifiers for every importable export of the given manifests; throws if a package has none to import.
export function entryImports(manifests) {
  const specifiers = [];
  const unreachable = [];
  for (const manifest of manifests) {
    const subpaths = exportSubpaths(manifest.exports);
    if (subpaths.length === 0) unreachable.push(manifest.name);
    for (const subpath of subpaths) specifiers.push(`${manifest.name}${subpath.slice(1)}`);
  }
  if (unreachable.length > 0) {
    throw new Error(
      `no importable export resolves a types file in: ${unreachable.join(', ')}; its declarations would go unchecked`
    );
  }
  return specifiers;
}

function writeEntries(consumerDir) {
  const scopeDir = path.join(consumerDir, 'node_modules', '@bike4mind');
  const manifests = fs
    .readdirSync(scopeDir)
    .sort()
    .map(dirName => readJson(path.join(scopeDir, dirName, 'package.json')));
  const specifiers = entryImports(manifests);
  const imports = declare =>
    specifiers.flatMap((specifier, i) => [declare(`m${i}`, JSON.stringify(specifier)), `void m${i};`]).join('\n');
  fs.writeFileSync(
    path.join(consumerDir, 'esm.mts'),
    `${imports((id, spec) => `import * as ${id} from ${spec};`)}\nexport {};\n`
  );
  fs.writeFileSync(
    path.join(consumerDir, 'cjs.cts'),
    `${imports((id, spec) => `import ${id} = require(${spec});`)}\nexport {};\n`
  );
  return specifiers.length;
}

function report(failed) {
  for (const { output } of failed.filter(result => result.dom)) console.error(output);
  const tscFailed = failed.filter(result => !result.dom);
  const output = tscFailed.map(result => result.output).join('\n');
  const groups = groupTscErrors(output);
  if (groups.size === 0 && output.trim()) console.error(output);
  for (const [owner, blocks] of groups) {
    console.error(`\n${owner} (${blocks.size})`);
    for (const block of blocks) console.error(`  ${block.split('\n').join('\n  ')}`);
  }
  if (tscFailed.some(result => result.output.trim())) {
    console.error(
      '\na published declaration references a name that does not exist; rebuild and inspect dist/*.d.{mts,cts}'
    );
  }
}

// A non-zero or null (killed) status is a failure.
export function failedResults(results) {
  return results.filter(result => result.status !== 0);
}

export function checkExitCode(results) {
  return failedResults(results).length ? 1 : 0;
}

function check(packages, pins, tmp) {
  const consumerDir = path.join(tmp, 'consumer');
  console.log(`packing ${packages.length} packages`);
  const tarballs = packAll(packages, path.join(tmp, 'tarballs'));
  console.log(`installing into a bare consumer with ${pins.join(' and ')}`);
  installConsumer(consumerDir, tarballs, pins);
  assertInstalledFromTarballs(consumerDir, packages);
  writeTsconfigs(consumerDir);
  selfTest(consumerDir);
  const entryCount = writeEntries(consumerDir);
  console.log(`self-test passed; checking ${entryCount} entry points`);

  const results = [];
  for (const { name } of CONFIGS) {
    const result = typecheck(consumerDir, `tsconfig.${name}.json`, ['--listFiles']);
    const { listing, diagnostics } = splitTscOutput(result.output);
    const domFiles = domLibFiles(listing).map(file => path.basename(file));
    const tscResult = { status: result.status, output: diagnostics };
    results.push(tscResult);
    if (domFiles.length > 0) {
      const output = `${name}: DOM lib files are in the consumer program (${domFiles.join(', ')}); a published declaration or one of its dependencies references a DOM lib. Re-run with KEEP_TMP=1 and run "npx tsc -p tsconfig.${name}.json --explainFiles" in the consumer to find which.`;
      results.push({ status: 1, output, dom: true });
    }
    const clean = result.status === 0 && domFiles.length === 0;
    console.log(`${name}: ${clean ? 'clean' : result.signal ? `tsc killed by ${result.signal}` : 'errors'}`);
  }
  const exitCode = checkExitCode(results);
  if (exitCode === 0) {
    console.log('OK: every published declaration type-checks with skipLibCheck off');
  } else {
    report(failedResults(results));
  }
  return exitCode;
}

function main() {
  const packages = discoverPackages();
  const pins = installedPins();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'published-dts-'));
  try {
    return check(packages, pins, tmp);
  } finally {
    if (process.env.KEEP_TMP === '1') console.log(`kept ${tmp}`);
    else {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (error) {
        console.error(`warning: could not remove ${tmp}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let exitCode = 1;
  try {
    exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(exitCode);
}
