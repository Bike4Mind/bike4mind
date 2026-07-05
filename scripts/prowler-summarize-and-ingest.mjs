#!/usr/bin/env node
/**
 * Prowler findings normalizer and ingest script.
 *
 * Usage:
 *   node scripts/prowler-summarize-and-ingest.mjs <prowler-output.json>
 *
 * Required env vars:
 *   INGEST_BASE_URL              — e.g. https://app.staging.bike4mind.com
 *   SECOPS_PROWLER_INGEST_TOKEN  — matches the deployed SST secret
 *
 * Optional env vars:
 *   PROWLER_STAGE                — SST stage label for the snapshot record
 *                                  (e.g. dev, production, pr1234). Required so
 *                                  the dashboard reads the snapshot under the
 *                                  same stage label the ingest API stores it.
 */

import fs from 'fs';

const PROWLER_OUTPUT_FILE = process.argv[2];
const INGEST_BASE_URL = process.env.INGEST_BASE_URL;
const SECOPS_PROWLER_INGEST_TOKEN = process.env.SECOPS_PROWLER_INGEST_TOKEN;
const PROWLER_STAGE = process.env.PROWLER_STAGE;

if (!PROWLER_OUTPUT_FILE || !INGEST_BASE_URL || !SECOPS_PROWLER_INGEST_TOKEN) {
  console.error('Usage: node prowler-summarize-and-ingest.mjs <prowler-output.json>');
  console.error('Required env vars: INGEST_BASE_URL, SECOPS_PROWLER_INGEST_TOKEN');
  process.exit(1);
}

// Map Prowler v5 JSON-OCSF severity labels to our schema; Informational is filtered out
const SEVERITY_MAP = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Informational: null,
};

async function main() {
  if (!fs.existsSync(PROWLER_OUTPUT_FILE)) {
    console.error(`File not found: ${PROWLER_OUTPUT_FILE}`);
    process.exit(1);
  }

  const rawOutput = fs.readFileSync(PROWLER_OUTPUT_FILE, 'utf-8');
  const allFindings = JSON.parse(rawOutput);

  if (!Array.isArray(allFindings)) {
    console.error('Prowler output must be a JSON array');
    process.exit(1);
  }

  const normalizedFindings = allFindings
    .filter(f => f.status_code === 'FAIL')
    .map(f => {
      const severity = SEVERITY_MAP[f.severity] ?? null;
      if (!severity) {
        if (f.severity && f.severity !== 'Informational') {
          console.warn(`Unknown severity value '${f.severity}' — skipping finding`);
        }
        return null;
      }
      const checkId = f.metadata?.event_code;
      if (!checkId) return null;
      const resource = f.resources?.[0];
      const docUrl =
        f.unmapped?.related_url ||
        f.remediation?.references?.find(r => typeof r === 'string' && r.startsWith('http')) ||
        '';
      return {
        id: checkId,
        title: f.finding_info?.title || checkId,
        severity,
        status: 'FAIL',
        description: f.finding_info?.desc || '',
        recommendation: f.remediation?.desc || '',
        documentationUrl: docUrl,
        // resource.uid is the OCSF-canonical ARN; data.metadata.arn is a Prowler-specific fallback
        region: resource?.region || f.cloud?.region || undefined,
        resourceArn: resource?.uid || resource?.data?.metadata?.arn || undefined,
      };
    })
    .filter(Boolean);

  const counts = {
    critical: normalizedFindings.filter(f => f.severity === 'critical').length,
    high: normalizedFindings.filter(f => f.severity === 'high').length,
    medium: normalizedFindings.filter(f => f.severity === 'medium').length,
    low: normalizedFindings.filter(f => f.severity === 'low').length,
  };

  console.log(`Prowler output: ${allFindings.length} total findings, ${normalizedFindings.length} failures to ingest`);
  console.log(`Severity: critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low}`);

  const ingestUrl = `${INGEST_BASE_URL}/api/admin/security-dashboard/cloud-prowler-ingest`;
  const payload = {
    ...(PROWLER_STAGE ? { stage: PROWLER_STAGE } : {}),
    counts,
    findings: normalizedFindings,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };

  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-security-ingest-token': SECOPS_PROWLER_INGEST_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  const response = await res.json();
  console.log('Prowler findings ingested successfully');
  console.log(`  Snapshot ID: ${response._id ?? response.id ?? '(unknown)'}`);
}

main().catch(err => {
  console.error('Ingest failed:', err.message);
  process.exit(1);
});
