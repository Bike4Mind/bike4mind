#!/usr/bin/env node

import fs from 'fs/promises';

async function main() {
  const reportPath = process.env.ZAP_JSON_REPORT_PATH || 'zap-report.json';
  const ingestUrl = process.env.LUMINA5_INGEST_URL;
  const ingestToken = process.env.LUMINA5_INGEST_TOKEN;

  if (!ingestUrl || ! ingestToken) {
    console.error('LUMINA5_INGEST_URL or LUMINA5_INGEST_TOKEN not set; skipping ingest.');
    process.exit(0);
  }

  // Check if report file exists before trying to read it
  try {
    await fs.access(reportPath);
  } catch {
    console.warn(`ZAP report not found at ${reportPath}. This likely means the ZAP scan failed or was skipped.`);
    console.warn('Check the "Run OWASP ZAP Baseline Scan" step logs for details.');
    process.exit(0); // Exit gracefully - don't fail the workflow
  }

  let raw;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read ZAP JSON report at ${reportPath}`, err);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse ZAP JSON report', err);
    process.exit(1);
  }

  const targetFromEnv = process.env.ZAP_TARGET_URL || process.env.DEFAULT_ZAP_TARGET_URL;
  const stageFromEnv = process.env.ZAP_STAGE || process.env.DEFAULT_ZAP_STAGE || 'staging';

  const alerts = [];

  const sites = Array.isArray(data.site) ? data.site : Array.isArray(data.sites) ? data.sites : [];
  for (const site of sites) {
    const siteAlerts = Array.isArray(site.alerts) ? site.alerts : Array.isArray(site.alert) ? site.alert : [];
    for (const alert of siteAlerts) {
      alerts.push(alert);
    }
  }

  if (alerts.length === 0 && Array.isArray(data.alerts)) {
    for (const alert of data.alerts) {
      alerts.push(alert);
    }
  }

  const normalizedAlerts = alerts.map(alert => {
    const name = alert.name || alert.alert || 'Unknown issue';
    const risk = String(alert.riskdesc || alert.risk || '').toLowerCase();
    let severity = 'low';
    if (risk.includes('critical')) severity = 'critical';
    else if (risk.includes('high')) severity = 'high';
    else if (risk.includes('medium')) severity = 'medium';
    else if (risk.includes('low')) severity = 'low';

    const description = alert.desc || alert.description || '';
    const solution = alert.solution || alert.remediation || '';
    const reference = Array.isArray(alert.reference)
      ? alert.reference[0]
      : alert.reference || alert.referenceUrl || undefined;

    const rawId = alert.pluginId || alert.id || name;
    const id = String(rawId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'zap-alert';

    // Include full instances array for SecOps Triage fan-out.
    // The ingest endpoint strips instances before saving to MongoDB (security concern);
    // the full payload is forwarded via SQS to the triage Lambda for GitHub issue creation.
    const rawInstances = Array.isArray(alert.instances) ? alert.instances : [];
    const instances = rawInstances.map(i => ({
      uri: i.uri || '',
      ...(i.param ? { param: i.param } : {}),
      ...(i.evidence ? { evidence: i.evidence } : {}),
      ...(i.otherinfo ? { otherinfo: i.otherinfo } : {}),
    }));

    return {
      id,
      title: name,
      severity,
      description,
      recommendation: solution || undefined,
      documentationUrl: reference || undefined,
      instances,
    };
  });

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of normalizedAlerts) {
    if (a.severity === 'critical') counts.critical += 1;
    else if (a.severity === 'high') counts.high += 1;
    else if (a.severity === 'medium') counts.medium += 1;
    else counts.low += 1;
  }

  const payload = {
    stage: stageFromEnv,
    targetUrl: targetFromEnv,
    counts,
    alerts: normalizedAlerts,
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
      console.error(`Failed to ingest ZAP results: ${res.status} ${res.statusText}`, text);
      process.exit(1);
    }

    console.log('Successfully ingested ZAP results into Security Dashboard');
  } catch (err) {
    console.error('Error sending ZAP results to ingest endpoint', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error in zap-summarize-and-ingest', err);
  process.exit(1);
});


