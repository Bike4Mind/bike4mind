#!/usr/bin/env node

// Pre-deploy check: every DNS validation record that the stage's issued Router certificate
// relies on must still exist in Route53.
//
// ACM reuses one validation CNAME per domain (a wildcard shares its base domain's record), so
// when a SAN change makes ACM reissue the certificate, the domains carried over keep the same
// records and SST sees no diff for them. `sst deploy` does not refresh state, so a record that
// was deleted outside SST is never recreated: the new certificate sits in PENDING_VALIDATION and
// the deploy waits on CertificateValidation until something times out. The same missing record
// also makes ACM auto-renewal fail silently. Checking the ISSUED certificate covers both cases;
// records for a newly added SAN do not exist yet and SST creates them during the deploy.
//
// Read-only: ACM ListCertificates/DescribeCertificate and Route53 ListHostedZones/
// ListResourceRecordSets through the aws CLI. Router certificates live in us-east-1 (CloudFront).
// The Router certificate and its records are created in infra/router.ts.
//
// Usage: SERVER_DOMAIN=<domain> node scripts/check-acm-validation-records.mjs [--domain <cert domain>]
// Skips (exit 0) when APP_CERT_ARN is set (the operator owns that certificate) or no domain is set.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CERT_REGION = 'us-east-1';

export function normalizeDnsName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

// Validation options for a certificate -> one entry per distinct record, keeping every domain
// that depends on it (a base domain and its wildcard share one record).
export function uniqueValidationRecords(validationOptions) {
  const byKey = new Map();
  for (const option of validationOptions ?? []) {
    const record = option?.ResourceRecord;
    if (!record?.Name || !record?.Value) continue;
    const name = normalizeDnsName(record.Name);
    const type = record.Type ?? 'CNAME';
    const key = `${type} ${name}`;
    const entry = byKey.get(key) ?? { name, type, value: normalizeDnsName(record.Value), domains: [] };
    entry.domains.push(option.DomainName);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

// Longest public hosted zone whose name is a suffix of the record name.
export function pickHostedZone(recordName, zones) {
  const name = normalizeDnsName(recordName);
  let best = null;
  for (const zone of zones ?? []) {
    if (zone?.Config?.PrivateZone) continue;
    const zoneName = normalizeDnsName(zone.Name);
    if (name !== zoneName && !name.endsWith(`.${zoneName}`)) continue;
    if (!best || zoneName.length > normalizeDnsName(best.Name).length) best = zone;
  }
  return best;
}

// `found` is the record set Route53 returned at (or after) the record's name, or null.
export function compareRecord(required, found) {
  if (!found) return 'missing';
  if (normalizeDnsName(found.Name) !== required.name || found.Type !== required.type) return 'missing';
  const values = (found.ResourceRecords ?? []).map(r => normalizeDnsName(r.Value));
  return values.includes(required.value) ? 'ok' : 'wrong-value';
}

// Problems are reported by domain, never by the record name or value: those are account-specific
// tokens and this output lands in CI logs.
export function formatProblems(problems, stage) {
  const lines = problems.map(p => {
    const reason =
      p.status === 'no-zone'
        ? 'no public hosted zone covers its validation record'
        : p.status === 'wrong-value'
          ? 'its validation record has a different value'
          : 'its validation record is missing from Route53';
    return `  - ${p.domains.join(', ')}: ${reason}`;
  });
  const stageArg = stage ? ` --stage ${stage}` : '';
  return [
    'ACM validation records are missing or wrong for the Router certificate:',
    ...lines,
    'Deploying now would leave a reissued certificate in PENDING_VALIDATION, and auto-renewal will fail.',
    `Fix: run \`sst refresh${stageArg} --target Router\` so the next deploy recreates the records, or`,
    'UPSERT each record shown by `aws acm describe-certificate --region us-east-1` into its zone.',
  ].join('\n');
}

function aws(args) {
  const out = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim() ? JSON.parse(out) : null;
}

function listCertificates(domain, statuses) {
  const result = aws(['acm', 'list-certificates', '--region', CERT_REGION, '--certificate-statuses', ...statuses]);
  return (result?.CertificateSummaryList ?? []).filter(c => normalizeDnsName(c.DomainName) === domain);
}

function lookupRecord(zone, record) {
  const result = aws([
    'route53',
    'list-resource-record-sets',
    '--hosted-zone-id',
    zone.Id,
    '--start-record-name',
    record.name,
    '--start-record-type',
    record.type,
    '--max-items',
    '1',
  ]);
  return result?.ResourceRecordSets?.[0] ?? null;
}

function parseDomainArg(argv) {
  const i = argv.indexOf('--domain');
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  if (process.env.APP_CERT_ARN) {
    console.log('APP_CERT_ARN is set: the Router certificate is operator-managed, skipping.');
    return;
  }
  const serverDomain = process.env.SERVER_DOMAIN;
  const certDomain = normalizeDnsName(parseDomainArg(process.argv) ?? (serverDomain ? `app.${serverDomain}` : ''));
  if (!certDomain) {
    console.log('No SERVER_DOMAIN set: the stage has no custom domain, skipping.');
    return;
  }

  const issued = listCertificates(certDomain, ['ISSUED']);
  const pending = listCertificates(certDomain, ['PENDING_VALIDATION']);
  if (pending.length > 0) {
    console.warn(
      `Note: ${pending.length} certificate(s) for ${certDomain} are PENDING_VALIDATION. ` +
        'If none is in use, they may be leftovers from an earlier failed deploy.'
    );
  }
  if (issued.length === 0) {
    console.log(`No issued certificate for ${certDomain} yet (first deploy?), nothing to check.`);
    return;
  }

  const zones = aws(['route53', 'list-hosted-zones'])?.HostedZones ?? [];
  const problems = [];
  let checked = 0;
  for (const summary of issued) {
    const cert = aws([
      'acm',
      'describe-certificate',
      '--region',
      CERT_REGION,
      '--certificate-arn',
      summary.CertificateArn,
    ])?.Certificate;
    for (const record of uniqueValidationRecords(cert?.DomainValidationOptions)) {
      checked += 1;
      const zone = pickHostedZone(record.name, zones);
      const status = zone ? compareRecord(record, lookupRecord(zone, record)) : 'no-zone';
      if (status !== 'ok') problems.push({ domains: record.domains, status });
    }
  }

  if (problems.length > 0) {
    console.error(formatProblems(problems, process.env.SEED_STAGE_NAME));
    process.exit(1);
  }
  console.log(`ACM validation records OK for ${certDomain} (${checked} record(s) checked).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
