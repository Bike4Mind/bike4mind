#!/usr/bin/env node

// Pre-deploy check: every DNS validation record that the stage's in-use Router certificate
// relies on must still exist in Route53.
//
// ACM reuses one validation CNAME per domain (a wildcard shares its base domain's record), so
// when a SAN change makes ACM reissue the certificate, the domains carried over keep the same
// records and SST sees no diff for them. `sst deploy` does not refresh state, so a record that
// was deleted outside SST is never recreated: the new certificate sits in PENDING_VALIDATION and
// the deploy waits on CertificateValidation until something times out. The same missing record
// also makes ACM auto-renewal fail silently. Checking the ISSUED certificate that CloudFront uses
// covers both cases; records for a newly added SAN do not exist yet and SST creates them during
// the deploy. Unused ISSUED and PENDING_VALIDATION certificates (leftovers of an earlier
// replacement or failed deploy) only produce a warning: their records may be gone on purpose,
// and failing on them would block every deploy with nothing `sst refresh` could fix.
//
// Read-only: ACM ListCertificates/DescribeCertificate and Route53 ListHostedZones/
// ListResourceRecordSets through the aws CLI. Router certificates live in us-east-1 (CloudFront).
// The Router certificate and its records are created in infra/router.ts.
//
// Usage: SERVER_DOMAIN=<domain> node scripts/check-acm-validation-records.mjs [--domain <cert domain>]
// Skips (exit 0) when APP_CERT_ARN is set (the operator owns that certificate) or no domain is set.
// Pass APP_CERT_ARN to this step exactly as to the deploy step. ACM_VALIDATION_CHECK=warn reports
// problems without failing, as an emergency bypass for a deploy that does not touch the cert.

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
  const fixes = [];
  if (problems.some(p => p.status !== 'no-zone')) {
    fixes.push(
      `Fix: run \`sst refresh${stageArg} --target Router\` so the next deploy recreates the records, or`,
      'UPSERT each record shown by `aws acm describe-certificate --region us-east-1` into its zone.'
    );
  }
  if (problems.some(p => p.status === 'no-zone')) {
    fixes.push(
      'For a domain with no hosted zone: create or delegate a public hosted zone that covers it, or',
      'remove that domain from the certificate.'
    );
  }
  return [
    'ACM validation records are missing or wrong for the Router certificate:',
    ...lines,
    'Deploying now would leave a reissued certificate in PENDING_VALIDATION, and auto-renewal will fail.',
    ...fixes,
  ].join('\n');
}

// Keeps CLI failures readable in CI and free of 12-digit account ids (ARNs in the failed command
// line and AccessDenied messages both carry them).
export function redactAccountIds(text) {
  return String(text ?? '').replace(/\b\d{12}\b/g, '<account>');
}

export class CheckError extends Error {}

export function runAwsCli(args, exec = execFileSync) {
  try {
    const out = exec('aws', [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    if (err?.code === 'ENOENT') throw new CheckError('aws CLI not found on PATH');
    const detail = redactAccountIds(err?.stderr || err?.message || err).trim();
    throw new CheckError(`aws ${args[0]} ${args[1]} failed: ${detail}`);
  }
}

const CERT_KEY_TYPES = 'keyTypes=RSA_2048,RSA_3072,RSA_4096,EC_prime256v1,EC_secp384r1,EC_secp521r1';

function listCertificates(aws, domain, statuses) {
  const result = aws([
    'acm',
    'list-certificates',
    '--region',
    CERT_REGION,
    '--certificate-statuses',
    ...statuses,
    '--includes',
    CERT_KEY_TYPES,
  ]);
  return (result?.CertificateSummaryList ?? []).filter(c => normalizeDnsName(c.DomainName) === domain);
}

function lookupRecord(aws, zone, record) {
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
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new CheckError('--domain needs a value');
  return value;
}

// Returns the process exit code. `aws` and `log` are injectable for tests.
export function run({ env = process.env, argv = process.argv, aws = runAwsCli, log = console } = {}) {
  if (env.APP_CERT_ARN) {
    log.log('APP_CERT_ARN is set: the Router certificate is operator-managed, skipping.');
    return 0;
  }
  const serverDomain = env.SERVER_DOMAIN;
  const certDomain = normalizeDnsName(parseDomainArg(argv) ?? (serverDomain ? `app.${serverDomain}` : ''));
  if (!certDomain) {
    log.log('No SERVER_DOMAIN or --domain given, so there is no Router certificate to check; skipping.');
    return 0;
  }

  const pending = listCertificates(aws, certDomain, ['PENDING_VALIDATION']);
  if (pending.length > 0) {
    log.warn(
      `Note: ${pending.length} certificate(s) for ${certDomain} are PENDING_VALIDATION. ` +
        'If none is in use, they may be leftovers from an earlier failed deploy.'
    );
  }

  const issued = listCertificates(aws, certDomain, ['ISSUED']);
  const inUse = [];
  for (const summary of issued) {
    const cert = aws([
      'acm',
      'describe-certificate',
      '--region',
      CERT_REGION,
      '--certificate-arn',
      summary.CertificateArn,
    ])?.Certificate;
    if (cert?.InUseBy?.length > 0) inUse.push(cert);
  }
  if (issued.length > inUse.length) {
    log.warn(
      `Note: ${issued.length - inUse.length} issued certificate(s) for ${certDomain} are not in use and were not checked.`
    );
  }
  if (inUse.length === 0) {
    log.log(`No in-use issued certificate for ${certDomain} yet (first deploy?), nothing to check.`);
    return 0;
  }

  const zones = aws(['route53', 'list-hosted-zones'])?.HostedZones ?? [];
  const problems = [];
  let checked = 0;
  for (const cert of inUse) {
    for (const record of uniqueValidationRecords(cert.DomainValidationOptions)) {
      checked += 1;
      const zone = pickHostedZone(record.name, zones);
      const status = zone ? compareRecord(record, lookupRecord(aws, zone, record)) : 'no-zone';
      if (status !== 'ok') problems.push({ domains: record.domains, status });
    }
  }

  if (problems.length > 0) {
    const message = formatProblems(problems, env.SEED_STAGE_NAME);
    if (env.ACM_VALIDATION_CHECK === 'warn') {
      log.warn(`${message}\nACM_VALIDATION_CHECK=warn: continuing anyway.`);
      return 0;
    }
    log.error(message);
    return 1;
  }
  log.log(`ACM validation records OK for ${certDomain} (${checked} record(s) checked).`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    console.error(`ACM validation check could not run: ${err.message}`);
    process.exitCode = 1;
  }
}
