#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { parseDomainFactsFile, renderCohortCsv } from './signupCohortSweep';

const HELP = `Read-only signup grouping sweep: writes candidate cohorts of users to a CSV for review.

Usage:
  npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts report:signup-cohorts --out <file.csv> [options]

Selection:
  --since <ISO UTC>               only users created at or after this time
  --until <ISO UTC>               only users created before this time
  --max-users <n>                 stop after reading n users
Inputs:
  --facts <file.json>             domain facts: { "<domain>": { mxHosts, nameservers, registrar, registeredAt } }
  --shapes <a,b|any>              local-part shapes that count as a key (none unless given)
  --ignore-hosts <a,b>            MX/NS host suffixes of shared providers that never form a key
  --mailbox-domains <a,b>         shared mailbox domains to skip, on top of the built-in list
Tuning (omitted values use neutral placeholders; set them deliberately):
  --min-shared-key-kinds <n>      distinct key kinds two domains must share to link
  --min-domains <n>               smallest cohort reported, in domains
  --max-domains-per-key <n>       ASN / signup-time keys on more domains are reported as common keys
  --max-cohort-domains <n>        larger cohorts are marked too_broad for edge review
  --min-user-key-share <0-1>      share of a domain's users that must carry a user key
  --min-hex-length <n>            shortest run classified as hex in a local-part shape
  --registration-bucket-days <n>  registration-date bucket width
  --signup-bucket-hours <n>       signup-time bucket width

Uses only stored data (email, createdAt, signupMeta.asn/isDatacenter) plus the optional facts file.
No live DNS/RDAP lookups, no database writes, no action on any account. The CSV holds user ids and
domains, not email addresses.
`;

const positiveInt = z.coerce.number().int().positive();
const share = z.coerce.number().gt(0).max(1);
const isoDate = z.iso.datetime().transform(value => new Date(value));

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'max-users': { type: 'string' },
      facts: { type: 'string' },
      shapes: { type: 'string' },
      'ignore-hosts': { type: 'string' },
      'mailbox-domains': { type: 'string' },
      'min-shared-key-kinds': { type: 'string' },
      'min-domains': { type: 'string' },
      'max-domains-per-key': { type: 'string' },
      'max-cohort-domains': { type: 'string' },
      'min-user-key-share': { type: 'string' },
      'min-hex-length': { type: 'string' },
      'registration-bucket-days': { type: 'string' },
      'signup-bucket-hours': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.out) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const { userService } = await import('@bike4mind/services');
  const defaults = userService.DEFAULT_COHORT_OPTIONS;
  const list = (raw: string | undefined) =>
    (raw ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean);
  const intOr = (raw: string | undefined, fallback: number) => (raw === undefined ? fallback : positiveInt.parse(raw));
  const options: typeof defaults = {
    ...defaults,
    localPartShapes: values.shapes === 'any' ? 'any' : list(values.shapes),
    ignoredInfrastructureHosts: list(values['ignore-hosts']),
    sharedMailboxDomains: list(values['mailbox-domains']),
    minSharedKeyKinds: intOr(values['min-shared-key-kinds'], defaults.minSharedKeyKinds),
    minDomains: intOr(values['min-domains'], defaults.minDomains),
    maxDomainsPerKey: intOr(values['max-domains-per-key'], defaults.maxDomainsPerKey),
    maxCohortDomains: intOr(values['max-cohort-domains'], defaults.maxCohortDomains),
    minUserKeyShare:
      values['min-user-key-share'] === undefined ? defaults.minUserKeyShare : share.parse(values['min-user-key-share']),
    minHexLength: intOr(values['min-hex-length'], defaults.minHexLength),
    registrationBucketDays: intOr(values['registration-bucket-days'], defaults.registrationBucketDays),
    signupBucketHours: intOr(values['signup-bucket-hours'], defaults.signupBucketHours),
  };
  const facts = values.facts ? parseDomainFactsFile(JSON.parse(readFileSync(values.facts, 'utf8'))) : null;
  const maxUsers = values['max-users'] ? positiveInt.parse(values['max-users']) : undefined;
  const createdAt: Record<string, Date> = {};
  if (values.since) createdAt.$gte = isoDate.parse(values.since);
  if (values.until) createdAt.$lt = isoDate.parse(values.until);

  const { connectDB } = await import('@bike4mind/db-core');
  const { User } = await import('@bike4mind/database');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const mongoose = (await import('mongoose')).default;
  try {
    const uri = process.env.MONGODB_URI ?? Config.MONGODB_URI;
    // autoIndex/autoCreate off so connecting cannot build indexes or collections.
    await connectDB(uri.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });

    const query = User.find(Object.keys(createdAt).length ? { createdAt } : {}, {
      email: 1,
      createdAt: 1,
      'signupMeta.asn': 1,
      'signupMeta.isDatacenter': 1,
    })
      .read('secondaryPreferred')
      .lean();
    if (maxUsers) query.limit(maxUsers);

    const records: ReturnType<typeof userService.toSignupRecord>[] = [];
    for await (const doc of query.cursor()) {
      if (typeof doc.email !== 'string') continue;
      records.push(
        userService.toSignupRecord(
          {
            userId: String(doc._id),
            email: doc.email,
            createdAt: doc.createdAt instanceof Date ? doc.createdAt : null,
            asn: doc.signupMeta?.asn ?? null,
            isDatacenter: doc.signupMeta?.isDatacenter ?? null,
          },
          options
        )
      );
    }
    console.log(`Read ${records.length} users on stage="${Resource.App.stage}".`);

    const result = await userService.findCandidateCohorts(
      records,
      facts ? async domain => facts.get(domain) ?? null : null,
      options
    );
    writeFileSync(values.out, renderCohortCsv(result));
    const members = result.cohorts.reduce((sum, cohort) => sum + cohort.members.length, 0);
    console.log(
      `Wrote ${result.cohorts.length} candidate cohorts (${members} users) and ${result.commonKeys.length} common keys to ${values.out}.`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[signup-cohort-sweep] failed:', error);
  process.exitCode = 1;
});
