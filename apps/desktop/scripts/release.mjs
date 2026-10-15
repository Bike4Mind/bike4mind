#!/usr/bin/env node
// Release helpers for .github/workflows/desktop-release.yml. Pure functions are exported for
// release.test.ts; the CLI at the bottom is what the workflow calls. Plain .mjs so the macOS
// runner can run it with nothing but node, before or without a build. See docs/release.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @param {string} version */
export function parseVersion(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) throw new Error(`not a semver version: "${version}"`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Semver precedence: -1, 0 or 1. electron-updater offers an update only when the feed's version
 * is greater than the running one, so this is the ordering the whole pipeline has to agree with.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0;
    return left.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// The changesets entry prefix: PR link, commit link and author credit, in either changelog format.
const ENTRY_PREFIX =
  /^(?:\[#\d+\]\([^)]*\)\s*)?(?:\[`[0-9a-f]+`\]\([^)]*\)\s*)?(?:Thanks \[@[^\]]+\]\([^)]*\)!\s*)?-\s+|^[0-9a-f]{7,40}:\s+/;

export const MAINTENANCE_NOTE = 'Maintenance release: updated internal components.';

/**
 * The in-app release notes for `version`, from a changesets CHANGELOG.md, or null when the
 * changelog has no section for it.
 *
 * Only the entry text survives: the PR, commit and author links are for the repository, and a
 * bare "Updated dependencies" list names packages a user has never heard of. A section that is
 * nothing but those still gets a line, because an empty banner tells the user nothing.
 * @param {string} changelog
 * @param {string} version
 */
export function releaseNotesFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = lines.length;

  const entries = [];
  let current = null;
  let skipping = false;
  for (const line of lines.slice(start + 1, end)) {
    if (/^#{3,} /.test(line)) {
      current = null;
      skipping = false;
      continue;
    }
    if (line.startsWith('- ')) {
      const body = line.slice(2);
      skipping = /^Updated dependencies\b/.test(body);
      if (skipping) {
        current = null;
        continue;
      }
      current = [body.replace(ENTRY_PREFIX, '').trim()];
      entries.push(current);
      continue;
    }
    if (skipping || current === null) continue;
    if (line.trim() === '') continue;
    current.push(line.trim());
  }

  const text = entries
    .filter(entry => entry[0].length > 0)
    .map(entry => `- ${entry.join(' ')}`)
    .join('\n');
  return text.length > 0 ? text : MAINTENANCE_NOTE;
}

/** @param {string} value */
function unquote(value) {
  const trimmed = value.trim();
  if (/^'.*'$|^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Point every file in an electron-builder `latest-mac.yml` at the version's own prefix, and carry
 * the release notes.
 *
 * electron-builder writes bare file names, which a generic feed resolves against the feed root. The
 * artifacts are uploaded under `releases/v<version>/` instead, so that a published version is a
 * write-once directory and the manifest is the only object a release ever overwrites. The version
 * in the prefix also keeps electron-updater's differential download working: it finds the previous
 * blockmap by replacing the new version with the running one everywhere in the file's URL.
 *
 * Line-based rather than a YAML round trip on purpose: the format is electron-builder's own and
 * flat, and nothing here has a YAML parser without adding a dependency to the release path.
 * @param {string} manifest
 * @param {{ version: string, prefix: string, notes?: string | null }} options
 * @returns {{ text: string, files: string[] }}
 */
export function rewriteManifest(manifest, { version, prefix, notes }) {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  if (cleanPrefix.length === 0) throw new Error('an empty prefix would publish into the feed root');

  const files = new Set();
  let declared = null;
  let inNotes = false;
  const out = [];

  for (const line of manifest.replace(/\r\n/g, '\n').split('\n')) {
    if (inNotes) {
      if (/^\s/.test(line) || line === '') continue;
      inNotes = false;
    }
    if (/^releaseNotes:/.test(line)) {
      inNotes = true;
      continue;
    }

    const versionMatch = /^version:\s*(.+)$/.exec(line);
    if (versionMatch) declared = unquote(versionMatch[1]);

    const fileMatch = /^(\s*(?:-\s+)?)(url|path):\s*(.+)$/.exec(line);
    if (fileMatch) {
      const name = unquote(fileMatch[3]);
      if (name.includes('/') || name.includes(':')) {
        throw new Error(`expected a bare file name for ${fileMatch[2]}, got "${name}"`);
      }
      files.add(name);
      out.push(`${fileMatch[1]}${fileMatch[2]}: ${cleanPrefix}/${name}`);
      continue;
    }
    out.push(line);
  }

  if (declared !== version) {
    throw new Error(`manifest declares version ${declared ?? '(none)'}, expected ${version}`);
  }
  if (files.size === 0) throw new Error('manifest references no files');

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  if (notes && notes.trim().length > 0) {
    // An explicit indentation indicator, so notes whose first line starts with a space still parse.
    out.push('releaseNotes: |2-');
    for (const noteLine of notes.replace(/\r\n/g, '\n').trimEnd().split('\n')) {
      out.push(noteLine.length > 0 ? `  ${noteLine}` : '');
    }
  }

  return { text: `${out.join('\n')}\n`, files: [...files] };
}

/**
 * The stable first-install name for a versioned dmg, e.g. `Bike4Mind-1.2.3-arm64.dmg` becomes
 * `Bike4Mind-latest-arm64.dmg`. Tied to `dmg.artifactName` in electron-builder.yml.
 * @param {string} dmgName
 * @param {string} version
 */
export function latestDmgName(dmgName, version) {
  const name = basename(dmgName);
  const marker = `-${version}-`;
  if (!name.endsWith('.dmg') || !name.includes(marker)) {
    throw new Error(`"${name}" does not carry version ${version} the way dmg.artifactName names it`);
  }
  return name.replace(marker, '-latest-');
}

/** @param {string} manifest */
export function manifestVersion(manifest) {
  const match = /^version:\s*(.+)$/m.exec(manifest);
  return match ? unquote(match[1]) : null;
}

/**
 * Whether `candidate` may be published over the live manifest. A missing manifest is the first
 * release. Equal is refused as well as lower: electron-updater would never offer it, and a fresh
 * install from the latest dmg would get an older build than the feed claims.
 * @param {string} candidate
 * @param {string | null} liveManifest
 */
export function isAheadOfLive(candidate, liveManifest) {
  if (liveManifest === null || liveManifest.trim() === '') return { ahead: true, live: null };
  const live = manifestVersion(liveManifest);
  if (live === null) throw new Error('the live manifest names no version');
  return { ahead: compareVersions(candidate, live) > 0, live };
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function required(args, name) {
  const value = flag(args, name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

/** @param {string[]} argv */
export function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'version': {
      const { version } = JSON.parse(readText(resolve(DESKTOP_DIR, 'package.json')));
      parseVersion(version);
      return `${version}\n`;
    }
    case 'notes': {
      const version = required(args, 'version');
      const changelog = flag(args, 'changelog') ?? resolve(DESKTOP_DIR, 'CHANGELOG.md');
      let text;
      try {
        text = readText(changelog);
      } catch {
        throw new Error(`no changelog at ${changelog}`);
      }
      const notes = releaseNotesFor(text, version);
      if (notes === null) throw new Error(`${changelog} has no "## ${version}" section`);
      return `${notes}\n`;
    }
    case 'manifest': {
      const version = required(args, 'version');
      const notesFile = flag(args, 'notes-file');
      const { text, files } = rewriteManifest(readText(required(args, 'in')), {
        version,
        prefix: required(args, 'prefix'),
        notes: notesFile ? readText(notesFile) : null,
      });
      writeFileSync(required(args, 'out'), text);
      return `${files.join('\n')}\n`;
    }
    case 'latest-dmg':
      return `${latestDmgName(required(args, 'dmg'), required(args, 'version'))}\n`;
    case 'ahead': {
      const liveFile = flag(args, 'live');
      const { ahead, live } = isAheadOfLive(required(args, 'version'), liveFile ? readText(liveFile) : null);
      if (!ahead) throw new Error(`the feed already serves ${live}; refusing to publish over it`);
      return `${live ?? '(nothing published yet)'}\n`;
    }
    default:
      throw new Error('usage: release.mjs version | notes | manifest | latest-dmg | ahead');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`release.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
