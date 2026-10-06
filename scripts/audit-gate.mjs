#!/usr/bin/env node

// pnpm audit gate. Accepts advisories in both the classic "advisories" shape
// (pnpm audit) and the newer "vulnerabilities" shape.
//
// Full mode (BASE_JSON_REPORT_PATH unset): fails if any high/critical advisory
// GHSA in PACKAGES_JSON_REPORT_PATH is not in the committed allowlist. Used by
// the scheduled audit of main and for local runs.
//
// Diff mode (BASE_JSON_REPORT_PATH set): fails only on high/critical GHSAs that
// are in the head report but not in the base report (the ones a PR introduces).
// Advisories already on base are printed as warnings, not failures, so a new
// advisory against an existing dependency does not turn every open PR red.
// Unreadable or unrecognized base reports fail closed.
//
// Usage: pnpm audit --json > report.json && PACKAGES_JSON_REPORT_PATH=report.json node scripts/audit-gate.mjs
// Fix steps: CONTRIBUTING.md#fixing-a-dependency-advisory

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const BLOCKED_SEVERITIES = new Set(['high', 'critical']);

// Returns an array of {ghsa, severity, pkg} for new (not allowlisted) advisories.
// Returns null when the report has no recognized shape -- callers should fail closed.
export function extractNewAdvisories(data, allowlist) {
  if (!data || typeof data !== 'object') return null;
  const hasKnownShape =
    (data.advisories && typeof data.advisories === 'object') ||
    (data.vulnerabilities && typeof data.vulnerabilities === 'object');
  if (!hasKnownShape) return null;

  const newAdvisories = [];

  // Classic pnpm/npm audit "advisories" shape
  if (data.advisories && typeof data.advisories === 'object') {
    for (const advisory of Object.values(data.advisories)) {
      if (!advisory || typeof advisory !== 'object') continue;
      const severity = String(advisory.severity || '').toLowerCase();
      if (!BLOCKED_SEVERITIES.has(severity)) continue;
      const pkg = advisory.module_name || 'unknown';
      const ghsa = advisory.github_advisory_id;
      if (!ghsa) {
        // Fail closed: an unidentifiable high/critical advisory is exactly the
        // thing a human should look at -- surface it rather than silently skip.
        const id = advisory.id ?? advisory.cves?.[0] ?? 'unknown';
        newAdvisories.push({ ghsa: `<no GHSA id> (${id})`, severity, pkg });
        continue;
      }
      if (!allowlist.has(ghsa)) {
        newAdvisories.push({ ghsa, severity, pkg });
      }
    }
  }

  // Newer npm audit v2 "vulnerabilities" shape (fallback when advisories is absent/empty)
  if (newAdvisories.length === 0 && data.vulnerabilities && typeof data.vulnerabilities === 'object') {
    const seenGhsas = new Set();
    for (const [pkgName, vuln] of Object.entries(data.vulnerabilities)) {
      if (!vuln || typeof vuln !== 'object') continue;
      const severity = String(vuln.severity || '').toLowerCase();
      if (!BLOCKED_SEVERITIES.has(severity)) continue;
      const viaEntries = Array.isArray(vuln.via) ? vuln.via : [];
      const ghsas = viaEntries.map(v => v && v.url && v.url.match(/GHSA-[a-z0-9-]+/)?.[0]).filter(Boolean);
      for (const ghsa of ghsas) {
        if (!allowlist.has(ghsa) && !seenGhsas.has(ghsa)) {
          seenGhsas.add(ghsa);
          newAdvisories.push({ ghsa, severity, pkg: pkgName });
        }
      }
    }
  }

  return newAdvisories;
}

// Splits head's new advisories into those the change introduces and those
// already present on base. Returns null if either report has an unrecognized
// shape. Filters head's result rather than widening the allowlist so the
// shape-fallback logic in extractNewAdvisories reads head exactly as full mode does.
export function classifyAgainstBase(head, base, allowlist) {
  const headNew = extractNewAdvisories(head, allowlist);
  const baseNew = extractNewAdvisories(base, allowlist);
  if (headNew === null || baseNew === null) return null;
  const baseIds = new Set(baseNew.map(a => a.ghsa));
  return {
    introduced: headNew.filter(a => !baseIds.has(a.ghsa)),
    preExisting: headNew.filter(a => baseIds.has(a.ghsa)),
  };
}

const PLAYBOOK = 'CONTRIBUTING.md#fixing-a-dependency-advisory';

async function readReport(reportPath, label) {
  try {
    return JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read/parse ${label} audit report at ${reportPath}:`, err.message);
    process.exit(1);
  }
}

async function main() {
  const reportPath = process.env.PACKAGES_JSON_REPORT_PATH || 'packages-audit-report.json';
  const basePath = process.env.BASE_JSON_REPORT_PATH;
  const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-allowlist.json');

  const data = await readReport(reportPath, 'head');
  const base = basePath ? await readReport(basePath, 'base') : undefined;

  let allowlist;
  try {
    const allowlistRaw = await fs.readFile(allowlistPath, 'utf8');
    allowlist = new Set(JSON.parse(allowlistRaw));
  } catch (err) {
    console.error(`Failed to read allowlist at ${allowlistPath}:`, err.message);
    process.exit(1);
  }

  let newAdvisories;
  if (base === undefined) {
    newAdvisories = extractNewAdvisories(data, allowlist);
    if (newAdvisories === null) {
      console.error('Unrecognized audit report shape -- refusing to pass the gate.');
      console.error('Expected either "advisories" or "vulnerabilities" key in the JSON report.');
      process.exit(1);
    }
  } else {
    const classified = classifyAgainstBase(data, base, allowlist);
    if (classified === null) {
      console.error('Unrecognized audit report shape (head or base) -- refusing to pass the gate.');
      console.error('Expected either "advisories" or "vulnerabilities" key in both JSON reports.');
      process.exit(1);
    }
    newAdvisories = classified.introduced;
    for (const a of classified.preExisting) {
      console.log(
        `::warning::Pre-existing on base, not introduced by this PR: [${a.severity.toUpperCase()}] ${a.pkg} ${a.ghsa}`
      );
    }
    if (classified.preExisting.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
      const rows = classified.preExisting.map(a => `| ${a.ghsa} | ${a.pkg} | ${a.severity} |`);
      const summary = [
        '### Already on main (tracked by the scheduled audit, not failing this PR)',
        '',
        '| GHSA | Package | Severity |',
        '|---|---|---|',
        ...rows,
        '',
      ].join('\n');
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    }
  }

  if (newAdvisories.length > 0) {
    const what = base === undefined ? 'not in the allowlist' : "introduced by this PR's dependency changes";
    console.error(`\nAudit gate FAILED: ${newAdvisories.length} new high/critical advisory(s) ${what}:\n`);
    for (const a of newAdvisories) {
      console.error(`  [${a.severity.toUpperCase()}] ${a.pkg}: ${a.ghsa}`);
    }
    console.error(`\nSee ${PLAYBOOK} for the fix steps.`);
    console.error(
      `To accept a new advisory, add its GHSA ID to scripts/audit-allowlist.json with a comment in the PR explaining why.\n`
    );
    process.exit(1);
  }

  if (base === undefined) {
    console.log(
      `Audit gate passed. All high/critical advisories are in the allowlist (${allowlist.size} accepted, 0 new).`
    );
  } else {
    console.log('Audit gate passed. No new high/critical advisories introduced relative to base.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Unexpected error in audit-gate:', err);
    process.exit(1);
  });
}
