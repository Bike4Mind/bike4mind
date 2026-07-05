#!/usr/bin/env node

import fs from 'fs/promises';

async function main() {
  const reportPath = process.env.PACKAGES_JSON_REPORT_PATH || 'packages-audit-report.json';
  const ingestUrl = process.env.LUMINA5_INGEST_URL;
  const ingestToken = process.env.LUMINA5_INGEST_TOKEN;

  if (!ingestUrl || !ingestToken) {
    console.error('LUMINA5_INGEST_URL or LUMINA5_INGEST_TOKEN not set; skipping packages ingest.');
    process.exit(0);
  }

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read packages audit JSON report at ${reportPath}`, err);
    process.exit(1);
  }

  if (!raw || raw.trim().length === 0) {
    console.warn(`Packages audit JSON report at ${reportPath} is empty; no results to ingest.`);
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse packages audit JSON report', err);
    process.exit(1);
  }

  if (!data || typeof data !== 'object') {
    console.error('Packages audit JSON report is not a JSON object; aborting ingest.');
    process.exit(1);
  }

  const alerts = [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  // Helper to normalize severity values into the four buckets we use in the dashboard.
  function normalizeSeverity(input) {
    const value = String(input || '').toLowerCase();
    if (value === 'critical') return 'critical';
    if (value === 'high') return 'high';
    if (value === 'moderate' || value === 'medium') return 'medium';
    if (value === 'low') return 'low';
    return 'low';
  }

  // 1) npm/pnpm audit classic "advisories" structure
  if (data && data.advisories && typeof data.advisories === 'object') {
    for (const advisory of Object.values(data.advisories)) {
      if (!advisory || typeof advisory !== 'object') continue;

      const idRaw = advisory.id || advisory.github_advisory_id || advisory.cves?.[0] || advisory.module_name;
      const id = String(idRaw || 'packages-advisory')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const packageName = advisory.module_name || advisory.moduleName || advisory.name || 'unknown-package';
      const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
      const firstFinding = findings[0] || {};
      const currentVersion = firstFinding.version || advisory.version || 'unknown';

      const severity = normalizeSeverity(advisory.severity);
      const vulnerableRange = advisory.vulnerable_versions || advisory.vulnerableVersions || undefined;
      const recommendedVersion = advisory.patched_versions || advisory.recommendation || undefined;
      const documentationUrl = advisory.url || advisory.github_advisory_id || undefined;

      alerts.push({
        id,
        packageName,
        currentVersion,
        severity,
        vulnerableRange,
        recommendedVersion,
        documentationUrl,
      });

      if (severity === 'critical') counts.critical += 1;
      else if (severity === 'high') counts.high += 1;
      else if (severity === 'medium') counts.medium += 1;
      else counts.low += 1;
    }
  }

  // 2) Newer npm audit v2 "vulnerabilities" structure (if present and advisories were empty)
  if (alerts.length === 0 && data && data.vulnerabilities && typeof data.vulnerabilities === 'object') {
    for (const [pkgName, vuln] of Object.entries(data.vulnerabilities)) {
      if (!vuln || typeof vuln !== 'object') continue;

      const name = vuln.name || pkgName || 'unknown-package';
      const idRaw = vuln.source || vuln.id || name;
      const id = String(idRaw || 'packages-vulnerability')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const severity = normalizeSeverity(vuln.severity);
      const currentVersion = vuln.installedVersion || vuln.version || 'unknown';
      const vulnerableRange = vuln.range || vuln.vulnerableVersions || undefined;
      const recommendedVersion =
        (vuln.fixAvailable && typeof vuln.fixAvailable === 'string' && vuln.fixAvailable) || undefined;
      const documentationUrl = vuln.url || undefined;

      alerts.push({
        id,
        packageName: name,
        currentVersion,
        severity,
        vulnerableRange,
        recommendedVersion,
        documentationUrl,
      });

      if (severity === 'critical') counts.critical += 1;
      else if (severity === 'high') counts.high += 1;
      else if (severity === 'medium') counts.medium += 1;
      else counts.low += 1;
    }
  }

  const totalPackages =
    (data && data.metadata && typeof data.metadata.totalDependencies === 'number'
      ? data.metadata.totalDependencies
      : undefined) || undefined;

  const stageFromEnv = process.env.PACKAGES_STAGE || process.env.DEFAULT_PACKAGES_STAGE || 'dev';

  const payload = {
    stage: stageFromEnv,
    tool: 'pnpm-audit',
    targetUrl: 'repository: lumina5',
    counts,
    alerts,
    totalPackages,
    startedAt: process.env.PACKAGES_STARTED_AT || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SECURITY-INGEST-TOKEN': ingestToken,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed to ingest packages audit results: ${res.status} ${res.statusText}`, text);
      process.exit(1);
    }

    console.log('Successfully ingested packages audit results into Security Dashboard');
  } catch (err) {
    console.error('Error sending packages audit results to ingest endpoint', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error in packages-audit-summarize-and-ingest', err);
  process.exit(1);
});

