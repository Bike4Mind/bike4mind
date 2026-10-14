#!/usr/bin/env node

// Raises the root pnpm-workspace.yaml overrides past the high/critical advisories that
// scripts/audit-gate.mjs would fail on, in the same `name@<X: ^X` style as the
// hand-written fixes. Used by the scheduled audit job in
// .github/workflows/audit-gate.yml to open an auto-fix PR; a human reviews and
// merges it. Anything it cannot fix safely (no patched release, an unparseable
// patched range, an exact pin) is listed for a human instead of guessed.
//
// Usage: PACKAGES_JSON_REPORT_PATH=report.json AUTOFIX_SUMMARY_PATH=summary.md node scripts/audit-autofix.mjs
// Writes `changed=true|false` to $GITHUB_OUTPUT, and the skipped advisories to
// $AUTOFIX_SKIPPED_PATH, when set.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractNewAdvisories } from './audit-gate.mjs';
import { readOverrides, writeOverrides } from './lib-pnpm-workspace.mjs';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a, b) {
  const pa = a.match(VERSION).slice(1).map(Number);
  const pb = b.match(VERSION).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Lowest patched version to raise the floor to, or null when there is none or
// the range is not one of the simple `>=X` / `>=X <Y` forms joined by `||`.
// With several patched ranges, takes the lowest floor above every installed
// version; without installed versions, the highest floor.
export function patchedFloor(patchedVersions, installedVersions = []) {
  const parts = String(patchedVersions || '')
    .split('||')
    .map(p => p.trim());
  const floors = [];
  for (const part of parts) {
    const m = part.match(/^>=\s*(\S+)(?:\s+<\s*\S+)?$/);
    if (!m || !VERSION.test(m[1])) return null;
    floors.push(m[1]);
  }
  if (floors.length === 0) return null;
  floors.sort(compareVersions);
  if (floors.length === 1) return floors[0];
  const installed = installedVersions.filter(v => VERSION.test(v)).sort(compareVersions);
  if (installed.length === 0) return floors[floors.length - 1];
  const highest = installed[installed.length - 1];
  return floors.find(f => compareVersions(f, highest) > 0) ?? null;
}

// The semver line a caret range stays on: the major, or `0.minor` below 1.0.0.
function semverLine(v) {
  const [major, minor] = v.match(VERSION).slice(1).map(Number);
  return major === 0 ? `0.${minor}` : `${major}`;
}

// Every version of every package in a pnpm v9 lockfile's `packages:` section,
// whose keys are `name@version` (peer suffixes live under `snapshots:`). A line
// scan, because the audit job runs without installing a YAML parser.
export function lockfileVersions(lockText) {
  const versions = new Map();
  let inPackages = false;
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith('packages:');
      continue;
    }
    const m = inPackages && line.match(/^ {2}'?([^'\s]+?)'?:\s*$/);
    if (!m) continue;
    const at = m[1].lastIndexOf('@');
    if (at <= 0) continue;
    const name = m[1].slice(0, at);
    if (!versions.has(name)) versions.set(name, []);
    versions.get(name).push(m[1].slice(at + 1));
  }
  return versions;
}

// Why a floor cannot be applied, or null when it can. pnpm applies `name@<X: ^X`
// to every dependent whose declared range intersects `<X`, and the lockfile does
// not record declared ranges, so every installed copy, above or below X, must be
// on X's semver line. Each vulnerable copy must be below X or the floor fixes nothing.
function floorProblem(floor, vulnerable, installed) {
  if (vulnerable.length === 0 && installed.length === 0) return 'no installed version found';
  for (const v of vulnerable) {
    if (!VERSION.test(String(v))) return `installed \`${v}\` is not a plain version`;
    if (compareVersions(v, floor) >= 0) return `installed \`${v}\` is not below the patched floor \`${floor}\``;
  }
  for (const v of [...vulnerable, ...installed]) {
    if (!VERSION.test(String(v))) return `installed \`${v}\` is not a plain version`;
    if (semverLine(v) !== semverLine(floor)) return `installed \`${v}\` would move across a major to \`^${floor}\``;
  }
  return null;
}

// Splits an override key into package name and selector range (`@scope/x@<1.0.0`).
function parseOverrideKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, range: null };
  return { name: key.slice(0, at), range: key.slice(at + 1) };
}

// Returns { overrides, fixes, skipped, changed }. `overrides` is a new object
// with key order preserved; `currentOverrides` is not mutated. `installedVersions`
// maps a package to all its locked versions (see lockfileVersions); without it,
// only the advisory's vulnerable copies are checked.
export function computeOverrideFixes(report, allowlist, currentOverrides = {}, installedVersions = new Map()) {
  const failing = extractNewAdvisories(report, allowlist);
  if (failing === null) throw new Error('Unrecognized audit report shape');

  const skipped = [];
  const raw = new Map();
  for (const a of Object.values(report.advisories || {})) {
    if (a && a.github_advisory_id) raw.set(a.github_advisory_id, a);
  }

  // One target floor per package, the highest any of its advisories needs.
  const targets = new Map();
  for (const a of failing) {
    const adv = raw.get(a.ghsa);
    if (!adv) {
      skipped.push({ ...a, reason: 'no classic advisory record (needs a human)' });
      continue;
    }
    const installed = (adv.findings || []).map(f => f.version);
    const floor = patchedFloor(adv.patched_versions, installed);
    if (!floor) {
      skipped.push({ ...a, reason: `no usable patched version (\`${adv.patched_versions}\`): allowlist or replace` });
      continue;
    }
    const t = targets.get(a.pkg) || { floor, advisories: [], installed: [] };
    if (compareVersions(floor, t.floor) > 0) t.floor = floor;
    t.advisories.push(a);
    t.installed.push(...installed);
    targets.set(a.pkg, t);
  }

  let entries = Object.entries(currentOverrides);
  const fixes = [];
  for (const [pkg, { floor, advisories, installed }] of targets) {
    const problem = floorProblem(floor, installed, installedVersions.get(pkg) || []);
    if (problem) {
      for (const a of advisories) skipped.push({ ...a, reason: `${problem} (needs a human)` });
      continue;
    }
    const ownKeys = entries.map(([k]) => k).filter(k => parseOverrideKey(k).name === pkg);
    if (ownKeys.some(k => parseOverrideKey(k).range === null)) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${pkg}\` is pinned by a plain override (needs a human)` });
      continue;
    }
    // A floor is `name@<X: ^Y` with Y >= X. Anything else (a per-major range like
    // `name@>=4.0.0 <5.0.0`, or a line pin like `name@<4.0.0: ^3.15.1`) would be
    // overlapped or replaced across majors, so the package goes to a human.
    const floorOf = k => {
      const range = parseOverrideKey(k).range;
      const value = String(currentOverrides[k]);
      if (!range.startsWith('<') || !VERSION.test(range.slice(1))) return null;
      if (!value.startsWith('^') || !VERSION.test(value.slice(1))) return null;
      return compareVersions(value.slice(1), range.slice(1)) >= 0 ? range.slice(1) : null;
    };
    const nonFloor = ownKeys.find(k => !floorOf(k));
    if (nonFloor) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${nonFloor}\` is a range or line override, not a floor (needs a human)` });
      continue;
    }
    const covering = ownKeys.find(k => floorOf(k) && compareVersions(floorOf(k), floor) >= 0);
    if (covering) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${covering}\` already reaches the patched version (needs a human)` });
      continue;
    }
    const lowerFloors = ownKeys.filter(k => floorOf(k));
    // An existing floor on another major means that major is still in use; replacing
    // the floor would drop it and move those consumers across.
    const otherLine = lowerFloors.find(k => semverLine(String(currentOverrides[k]).slice(1)) !== semverLine(floor));
    if (otherLine) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${otherLine}\` holds a floor on another major (needs a human)` });
      continue;
    }
    const newKey = `${pkg}@<${floor}`;
    const newValue = `^${floor}`;
    const from = lowerFloors.map(k => `\`${k}: ${currentOverrides[k]}\``).join(', ') || '(none)';
    if (lowerFloors.length > 0) {
      // Replace the first lower selector in place and drop the rest, so the
      // package keeps a single, non-overlapping floor.
      const first = lowerFloors[0];
      entries = entries
        .map(([k, v]) => (k === first ? [newKey, newValue] : [k, v]))
        .filter(([k]) => !lowerFloors.slice(1).includes(k));
    } else {
      entries.push([newKey, newValue]);
    }
    for (const a of advisories) fixes.push({ ...a, from, to: `\`${newKey}: ${newValue}\`` });
  }

  return { overrides: Object.fromEntries(entries), fixes, skipped, changed: fixes.length > 0 };
}

// One `GHSA | package | severity | reason` line per skipped advisory, the input
// for the tracking issue's skipped block (scripts/audit-issue.mjs).
export function renderSkippedLines(skipped) {
  return skipped.map(s => `${s.ghsa} | ${s.pkg} | ${s.severity} | ${s.reason.replace(/\s+/g, ' ')}`);
}

function renderSummary({ fixes, skipped }, shapeNote) {
  const lines = [
    'Raises the `overrides` in `pnpm-workspace.yaml` past high/critical advisories found by the scheduled dependency audit of `main`.',
    '',
  ];
  if (shapeNote) lines.push(shapeNote, '');
  if (fixes.length > 0) {
    lines.push('| GHSA | Package | Severity | Old override | New override |', '|---|---|---|---|---|');
    for (const f of fixes) lines.push(`| ${f.ghsa} | ${f.pkg} | ${f.severity} | ${f.from} | ${f.to} |`);
    lines.push('');
  }
  if (skipped.length > 0) {
    lines.push('Not fixed automatically:', '');
    for (const s of skipped) lines.push(`- ${s.ghsa} (${s.pkg}, ${s.severity}): ${s.reason}`);
    lines.push('');
  }
  lines.push('Review the lockfile diff before merging. Fix steps: CONTRIBUTING.md#fixing-a-dependency-advisory');
  return lines.join('\n') + '\n';
}

async function main() {
  const reportPath = process.env.PACKAGES_JSON_REPORT_PATH || 'audit-report.json';
  const summaryPath = process.env.AUTOFIX_SUMMARY_PATH || 'autofix-summary.md';
  const skippedPath = process.env.AUTOFIX_SKIPPED_PATH;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const workspacePath = path.join(scriptDir, '..', 'pnpm-workspace.yaml');

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const allowlist = new Set(JSON.parse(await fs.readFile(path.join(scriptDir, 'audit-allowlist.json'), 'utf8')));
  const installed = lockfileVersions(await fs.readFile(path.join(scriptDir, '..', 'pnpm-lock.yaml'), 'utf8'));

  const result = computeOverrideFixes(report, allowlist, readOverrides(workspacePath), installed);
  const shapeNote =
    !report.advisories && report.vulnerabilities
      ? 'The report only has the `vulnerabilities` shape, which carries no patched versions; nothing was fixed automatically.'
      : '';

  if (result.changed) {
    writeOverrides(workspacePath, result.overrides);
  }
  if (skippedPath) {
    const lines = renderSkippedLines(result.skipped);
    await fs.writeFile(skippedPath, lines.map(l => l + '\n').join(''));
  }
  const summary = renderSummary(result, shapeNote);
  await fs.writeFile(summaryPath, summary);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  console.log(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('audit-autofix failed:', err.message);
    process.exit(1);
  });
}
