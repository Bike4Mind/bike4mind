#!/usr/bin/env node

// Regression-only pnpm audit gate.
// Reads a pnpm audit JSON report and fails if any high/critical advisory GHSA
// is not in the committed allowlist. Accepts advisories in both the classic
// "advisories" shape (pnpm audit) and the newer "vulnerabilities" shape.
//
// Usage: pnpm audit --json > report.json && PACKAGES_JSON_REPORT_PATH=report.json node scripts/audit-gate.mjs

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

async function main() {
  const reportPath = process.env.PACKAGES_JSON_REPORT_PATH || 'packages-audit-report.json';
  const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-allowlist.json');

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read audit report at ${reportPath}:`, err.message);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse audit report JSON:', err.message);
    process.exit(1);
  }

  let allowlist;
  try {
    const allowlistRaw = await fs.readFile(allowlistPath, 'utf8');
    allowlist = new Set(JSON.parse(allowlistRaw));
  } catch (err) {
    console.error(`Failed to read allowlist at ${allowlistPath}:`, err.message);
    process.exit(1);
  }

  const newAdvisories = extractNewAdvisories(data, allowlist);

  if (newAdvisories === null) {
    console.error('Unrecognized audit report shape -- refusing to pass the gate.');
    console.error('Expected either "advisories" or "vulnerabilities" key in the JSON report.');
    process.exit(1);
  }

  if (newAdvisories.length > 0) {
    console.error(`\nAudit gate FAILED: ${newAdvisories.length} new high/critical advisory(s) not in the allowlist:\n`);
    for (const a of newAdvisories) {
      console.error(`  [${a.severity.toUpperCase()}] ${a.pkg}: ${a.ghsa}`);
    }
    console.error(`\nTo accept a new advisory, add its GHSA ID to scripts/audit-allowlist.json with a comment in the PR explaining why.\n`);
    process.exit(1);
  }

  console.log(`Audit gate passed. All high/critical advisories are in the allowlist (${allowlist.size} accepted, 0 new).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Unexpected error in audit-gate:', err);
    process.exit(1);
  });
}
