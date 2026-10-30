#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  buildSweepOptions,
  parseDomainFactsFile,
  parseSignupSelection,
  readSignupRecords,
  renderCohortCsv,
} from './signupCohortSweep';

const HELP = `Read-only signup grouping sweep: writes candidate cohorts of users to a CSV for review.

Usage:
  npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts report:signup-cohorts --out <file.csv> [options]

Selection:
  --since <ISO UTC>               only users created at or after this time
  --until <ISO UTC>               only users created before this time
  --max-users <n>                 read only the n earliest signups in the window (warns when hit)
Inputs:
  --facts <file.json>             domain facts: { "<domain>": { mxHosts, nameservers, registrar, registeredAt } }
  --shapes <a,b|any>              local-part shapes that count as a key (none unless given)
  --ignore-hosts <a,b>            MX/NS host suffixes of shared providers that never form a key
  --mailbox-domains <a,b>         shared mailbox domains to skip, on top of the built-in list
Tuning (omitted values use neutral placeholders; set them deliberately):
  --min-shared-key-kinds <n>      distinct key kinds two domains must share to link
  --min-domains <n>               smallest cohort reported, in domains
  --max-domains-per-key <n>       ASN / signup-time keys on more domains are reported as common keys
  --max-domains-per-infra-key <n> MX / NS / registrar / shape keys on more domains are reported as common keys
  --max-cohort-domains <n>        larger cohorts are marked too_broad for edge review
  --min-user-key-share <0-1>      share of a domain's users that must carry a user key
  --min-hex-length <n>            shortest run classified as hex in a local-part shape
  --registration-bucket-days <n>  registration-date bucket width
  --signup-bucket-hours <n>       signup-time bucket width

Uses only stored data (email, createdAt, signupMeta.asn/isDatacenter) plus the optional facts file.
No live DNS/RDAP lookups, no database writes, no action on any account. The CSV holds user ids and
domains, not email addresses.
`;

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
      'max-domains-per-infra-key': { type: 'string' },
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
  const { help: _help, ...flags } = values;
  const options = buildSweepOptions(flags, defaults);
  const facts = values.facts ? parseDomainFactsFile(JSON.parse(readFileSync(values.facts, 'utf8'))) : null;
  const selection = parseSignupSelection(flags);

  const { connectDB } = await import('@bike4mind/db-core');
  const { User } = await import('@bike4mind/database');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const mongoose = (await import('mongoose')).default;
  try {
    const uri = process.env.MONGODB_URI ?? Config.MONGODB_URI;
    // autoIndex/autoCreate off so connecting cannot build indexes or collections.
    await connectDB(uri.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });

    const records = await readSignupRecords(User, selection, options);
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
