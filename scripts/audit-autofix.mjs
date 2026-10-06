#!/usr/bin/env node

// Raises root package.json pnpm.overrides past the high/critical advisories that
// scripts/audit-gate.mjs would fail on, in the same `name@<X: ^X` style as the
// hand-written fixes. Used by the scheduled audit job in
// .github/workflows/audit-gate.yml to open an auto-fix PR; a human reviews and
// merges it. Anything it cannot fix safely (no patched release, an unparseable
// patched range, an exact pin) is listed for a human instead of guessed.
//
// Usage: PACKAGES_JSON_REPORT_PATH=report.json AUTOFIX_SUMMARY_PATH=summary.md node scripts/audit-autofix.mjs
// Writes `changed=true|false` to $GITHUB_OUTPUT when set.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractNewAdvisories } from './audit-gate.mjs';

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

// Splits an override key into package name and selector range (`@scope/x@<1.0.0`).
function parseOverrideKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, range: null };
  return { name: key.slice(0, at), range: key.slice(at + 1) };
}

// Returns { overrides, fixes, skipped, changed }. `overrides` is a new object
// with key order preserved; `currentOverrides` is not mutated.
export function computeOverrideFixes(report, allowlist, currentOverrides = {}) {
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
    const t = targets.get(a.pkg) || { floor, advisories: [] };
    if (compareVersions(floor, t.floor) > 0) t.floor = floor;
    t.advisories.push(a);
    targets.set(a.pkg, t);
  }

  let entries = Object.entries(currentOverrides);
  const fixes = [];
  for (const [pkg, { floor, advisories }] of targets) {
    const ownKeys = entries.map(([k]) => k).filter(k => parseOverrideKey(k).name === pkg);
    if (ownKeys.some(k => parseOverrideKey(k).range === null)) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${pkg}\` is pinned by a plain override (needs a human)` });
      continue;
    }
    const floorOf = k => {
      const range = parseOverrideKey(k).range;
      return range.startsWith('<') && VERSION.test(range.slice(1)) ? range.slice(1) : null;
    };
    const covering = ownKeys.find(k => floorOf(k) && compareVersions(floorOf(k), floor) >= 0);
    if (covering) {
      for (const a of advisories)
        skipped.push({ ...a, reason: `\`${covering}\` already reaches the patched version (needs a human)` });
      continue;
    }
    const lowerFloors = ownKeys.filter(k => floorOf(k));
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

function renderSummary({ fixes, skipped }, shapeNote) {
  const lines = [
    'Raises `pnpm.overrides` past high/critical advisories found by the scheduled dependency audit of `main`.',
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
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(scriptDir, '..', 'package.json');

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const allowlist = new Set(JSON.parse(await fs.readFile(path.join(scriptDir, 'audit-allowlist.json'), 'utf8')));
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));

  const result = computeOverrideFixes(report, allowlist, pkg.pnpm?.overrides);
  const shapeNote =
    !report.advisories && report.vulnerabilities
      ? 'The report only has the `vulnerabilities` shape, which carries no patched versions; nothing was fixed automatically.'
      : '';

  if (result.changed) {
    pkg.pnpm = { ...pkg.pnpm, overrides: result.overrides };
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
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
