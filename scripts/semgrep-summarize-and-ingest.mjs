#!/usr/bin/env node

import fs from 'fs/promises';

async function main() {
  const reportPath = process.env.SEMGREP_JSON_REPORT_PATH || 'semgrep-report.json';
  const ingestUrl = process.env.LUMINA5_INGEST_URL;
  const ingestToken = process.env.LUMINA5_INGEST_TOKEN;

  if (!ingestUrl || !ingestToken) {
    console.error('LUMINA5_INGEST_URL or LUMINA5_INGEST_TOKEN not set; skipping Semgrep ingest.');
    process.exit(0);
  }

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read Semgrep JSON report at ${reportPath}`, err);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse Semgrep JSON report', err);
    process.exit(1);
  }

  const results = Array.isArray(data.results) ? data.results : [];

  const alerts = [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const result of results) {
    const ruleId = result.check_id || result.rule_id || 'semgrep-rule';
    const message = (result.extra && result.extra.message) || result.message || 'Semgrep finding';
    const severityRaw =
      (result.extra && result.extra.severity) || (result.severity && String(result.severity)) || 'INFO';
    const severityNormalized = String(severityRaw).toLowerCase();

    let severity = 'low';
    if (severityNormalized === 'error' || severityNormalized === 'critical') {
      severity = 'critical';
    } else if (severityNormalized === 'high') {
      severity = 'high';
    } else if (severityNormalized === 'medium' || severityNormalized === 'warning') {
      severity = 'medium';
    } else {
      severity = 'low';
    }

    const path = (result.path && String(result.path)) || (result.extra && result.extra.path) || 'unknown-file';
    const start = result.start || {};
    const line = typeof start.line === 'number' ? start.line : undefined;

    const documentationUrlRaw =
      (result.extra &&
        result.extra.metadata &&
        (result.extra.metadata.cwe || result.extra.metadata.reference || result.extra.metadata.documentation)) ||
      undefined;

    let documentationUrl;
    if (typeof documentationUrlRaw === 'string') {
      documentationUrl = documentationUrlRaw;
    } else if (Array.isArray(documentationUrlRaw) && documentationUrlRaw.length > 0) {
      documentationUrl = String(documentationUrlRaw[0]);
    } else if (documentationUrlRaw != null) {
      documentationUrl = String(documentationUrlRaw);
    }

    const id = String(ruleId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'semgrep-alert';

    alerts.push({
      id,
      title: message,
      severity,
      filePath: path,
      line,
      documentationUrl,
    });

    if (severity === 'critical') counts.critical += 1;
    else if (severity === 'high') counts.high += 1;
    else if (severity === 'medium') counts.medium += 1;
    else counts.low += 1;
  }

  const stageFromEnv = process.env.CODE_STAGE || process.env.DEFAULT_CODE_STAGE || 'dev';

  const payload = {
    stage: stageFromEnv,
    tool: 'semgrep',
    targetUrl: 'repository: lumina5',
    counts,
    alerts,
    startedAt: process.env.SEMGREP_STARTED_AT || new Date().toISOString(),
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
      console.error(`Failed to ingest Semgrep results: ${res.status} ${res.statusText}`, text);
      process.exit(1);
    }

    console.log('Successfully ingested Semgrep results into Security Dashboard');
  } catch (err) {
    console.error('Error sending Semgrep results to ingest endpoint', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error in semgrep-summarize-and-ingest', err);
  process.exit(1);
});


