#!/usr/bin/env node

import fs from 'fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Returns a stable SHA-256 hex digest of a secret value.
 * Used as the dedup key — never logged or forwarded.
 */
export function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Deduplicate gitleaks findings by {ruleId + secretHash}.
 * Multiple file locations for the same credential collapse into one entry
 * with a `locations` array, so one leaked secret = one dashboard alert.
 */
export function deduplicateLeaks(leaks) {
  const map = new Map();

  for (const leak of leaks) {
    if (!leak || typeof leak !== 'object') continue;

    const ruleId = leak.RuleID || leak.rule_id || leak.Rule || leak.rule || 'unknown';
    const secretValue = leak.Secret || leak.secret || '';
    const key = `${ruleId}:${hashSecret(secretValue)}`;

    const filePath = leak.File || leak.file || leak.Path || leak.path;
    const line = leak.StartLine || leak.start_line || leak.Line || leak.line;
    const commitId = leak.Commit || leak.commit;

    if (!map.has(key)) {
      map.set(key, { ...leak, locations: [] });
    }

    map.get(key).locations.push({
      filePath: filePath || undefined,
      line: typeof line === 'number' ? line : undefined,
      commitId: commitId || undefined,
    });
  }

  return Array.from(map.values());
}

// Path patterns that are definitionally non-production (test, example, docs)
const PLACEHOLDER_PATH_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__\//,
  /__fixtures__\//,
  /__mocks__\//,
  /\.env\..*example/i,
  /\.env\.example$/i,
  /README\.md$/i,
  /docs\//,
  /docs-site\//,
];

// Exact or pattern-matched values that are canonical placeholders / fake credentials
const PLACEHOLDER_VALUE_PATTERNS = [
  /^your[-_]secret[-_]here$/i,
  /^your[-_]api[-_]key$/i,
  /^changeme$/i,
  /^not[-_]configured$/i,
  /^my[-_]secret[-_]placeholder[-_]value$/i,
  /^AKIAIOSFODNN7EXAMPLE$/,
  /T00000000/,
  /B00000000/,
  /username:password/i,
  /user:pass@/i,
  /insert[-_].*[-_]here/i,
];

/**
 * Returns true if a gitleaks finding is a known placeholder or fixture —
 * i.e., it should be suppressed and not create a dashboard alert.
 */
export function isPlaceholderLeak(leak) {
  const filePath = leak.File || leak.file || leak.Path || leak.path || '';
  const secret = leak.Secret || leak.secret || '';

  for (const pattern of PLACEHOLDER_PATH_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }

  for (const pattern of PLACEHOLDER_VALUE_PATTERNS) {
    if (pattern.test(secret)) return true;
  }

  return false;
}

async function main() {
  const reportPath = process.env.SECRETS_JSON_REPORT_PATH || 'secrets-scan-report.json';
  const ingestUrl = process.env.LUMINA5_INGEST_URL;
  const ingestToken = process.env.LUMINA5_INGEST_TOKEN;

  if (!ingestUrl || !ingestToken) {
    console.error('LUMINA5_INGEST_URL or LUMINA5_INGEST_TOKEN not set; skipping secrets ingest.');
    process.exit(0);
  }

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read secrets scan JSON report at ${reportPath}`, err);
    process.exit(1);
  }

  if (!raw || raw.trim().length === 0) {
    console.warn(`Secrets scan JSON report at ${reportPath} is empty; no results to ingest.`);
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse secrets scan JSON report', err);
    process.exit(1);
  }

  if (!data) {
    console.error('Secrets scan JSON report is null/undefined; aborting ingest.');
    process.exit(1);
  }

  // Gitleaks typically returns either an array of leak objects or an object
  // with a "findings" / "leaks" array. Normalize to a flat array.
  let leaks = [];
  if (Array.isArray(data)) {
    leaks = data;
  } else if (Array.isArray(data.findings)) {
    leaks = data.findings;
  } else if (Array.isArray(data.leaks)) {
    leaks = data.leaks;
  } else {
    console.warn('Secrets scan JSON did not contain a recognizable findings array; no results to ingest.');
    process.exit(0);
  }

  // Drop placeholder/fixture findings first — evaluate each location independently
  // before dedup so a real credential is never silently lost because a sibling
  // test-fixture location happened to be emitted first.
  leaks = leaks.filter(leak => !isPlaceholderLeak(leak));

  // Deduplicate: one credential appearing in N files = one alert listing N locations
  leaks = deduplicateLeaks(leaks);

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const alerts = [];

  function normalizeSeverity(input) {
    const value = String(input || '').toLowerCase();
    if (value === 'critical') return 'critical';
    if (value === 'high') return 'high';
    if (value === 'medium' || value === 'moderate') return 'medium';
    if (value === 'low') return 'low';
    // Default to high for unknown severities to err on the side of caution.
    return 'high';
  }

  function inferSecretType(rule, description, tags) {
    const text = `${rule || ''} ${description || ''} ${(tags || []).join(' ')}`.toLowerCase();
    if (text.includes('apikey') || text.includes('api_key') || text.includes('api key')) return 'apiKey';
    if (text.includes('password') || text.includes('pwd')) return 'password';
    if (text.includes('token') || text.includes('bearer') || text.includes('secret')) return 'token';
    if (text.includes('webhook')) return 'webhook';
    if (text.includes('private key') || text.includes('rsa') || text.includes('ssh')) return 'privateKey';
    return 'other';
  }

  for (const leak of leaks) {
    if (!leak || typeof leak !== 'object') continue;

    const ruleId = leak.RuleID || leak.rule_id || leak.Rule || leak.rule || 'secrets-leak';
    const id = String(ruleId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const filePath = leak.File || leak.file || leak.Path || leak.path;
    const line = leak.StartLine || leak.start_line || leak.Line || leak.line;
    const commitId = leak.Commit || leak.commit;
    const description = leak.Description || leak.description || '';
    const tags = Array.isArray(leak.Tags) ? leak.Tags : Array.isArray(leak.tags) ? leak.tags : [];

    const severity = normalizeSeverity(leak.Severity || leak.severity);
    const secretType = inferSecretType(ruleId, description, tags);

    alerts.push({
      id: `${id}-${filePath || 'unknown'}-${line || '0'}`,
      secretType,
      severity,
      filePath: filePath || undefined,
      line: typeof line === 'number' ? line : undefined,
      commitId: commitId || undefined,
      // We never include the raw secret value here; description is metadata only.
      description: description || undefined,
      recommendation: undefined,
      documentationUrl: undefined,
      locations: Array.isArray(leak.locations) ? leak.locations : undefined,
    });

    if (severity === 'critical') counts.critical += 1;
    else if (severity === 'high') counts.high += 1;
    else if (severity === 'medium') counts.medium += 1;
    else counts.low += 1;
  }

  const stageFromEnv = process.env.SECRETS_STAGE || process.env.DEFAULT_SECRETS_STAGE || 'dev';

  const payload = {
    stage: stageFromEnv,
    tool: 'gitleaks',
    targetUrl: 'repository: lumina5',
    counts,
    alerts,
    startedAt: process.env.SECRETS_STARTED_AT || new Date().toISOString(),
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
      console.error(`Failed to ingest secrets scan results: ${res.status} ${res.statusText}`, text);
      process.exit(1);
    }

    console.log('Successfully ingested secrets scan results into Security Dashboard');
  } catch (err) {
    console.error('Error sending secrets scan results to ingest endpoint', err);
    process.exit(1);
  }
}

// Only run main() when executed directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Unexpected error in secrets-scan-summarize-and-ingest', err);
    process.exit(1);
  });
}

