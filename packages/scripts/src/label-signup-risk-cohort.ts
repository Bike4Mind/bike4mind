#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { baselineRules } from '@bike4mind/server-utils/analytics/signupBaseline';
import { userService } from '@bike4mind/services';
import { z } from 'zod';

const HELP = `Read-only: label recent signups for signup risk replay.

Usage: report:signup-risk-cohort --since <ISO UTC> [--until <ISO UTC>] --policy <policy.json> --out <replay-input.json>
       [--test-pattern <regex>]

Labels each signup in [since, until) as legitimate or suspected by the product definition: a verified
email; not banned, moderated or held by signup review; and a successful AI request within 7 days of
signup. Signups whose 7-day window is still open are skipped, so set --until at least 7 days back for
a full cohort. Only signups assessed after grant-time signal recording shipped carry replayable signals.

--policy is the candidate signupGrantRiskPolicy (enabled) to replay. --out receives the replay input,
written with mode 600 and never overwritten; pass it to replaySignupRisk.ts. Set
NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS so staff accounts are excluded; test accounts match --test-pattern or
ANALYTICS_TEST_PATTERN (the signup baseline's default otherwise). Prints aggregate counts only: no emails, ids or network data.
`;

async function readPolicy(path: string) {
  const parsed = userService.signupRiskPolicySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success || !parsed.data.enabled) throw new Error('--policy must be a valid, enabled signup risk policy');
  return parsed.data;
}

async function main() {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      policy: { type: 'string' },
      out: { type: 'string' },
      'test-pattern': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.since || !values.policy || !values.out) throw new Error('--since, --policy and --out are required');
  const date = z.iso.datetime().transform(value => new Date(value));
  const now = new Date();
  const since = date.parse(values.since);
  const until = values.until ? date.parse(values.until) : now;
  if (since >= until) throw new Error('--since must be before --until');
  const policy = await readPolicy(values.policy);
  const { staffEmail, testEmail } = baselineRules(
    process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS,
    values['test-pattern'] ?? process.env.ANALYTICS_TEST_PATTERN
  );

  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { buildSignupRiskCohort } = await import('./signupRiskCohort');
  const mongoose = (await import('mongoose')).default;
  try {
    const uri = process.env.MONGODB_URI ?? Config.MONGODB_URI;
    await connectDB(uri.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });
    const { samples, skipped } = await buildSignupRiskCohort({
      since,
      until,
      now,
      internalEmails: staffEmail ? [staffEmail, testEmail] : [testEmail],
    });
    if (samples.length === 0) throw new Error('No labeled signups with recorded signals in this window');
    await writeFile(values.out, `${JSON.stringify({ policy, samples })}\n`, { mode: 0o600, flag: 'wx' });
    const count = (cohort: string) => samples.filter(sample => sample.cohort === cohort).length;
    console.log(JSON.stringify({ legitimate: count('legitimate'), suspected: count('suspected'), skipped }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[signup-risk-cohort] failed:', error instanceof Error ? error.message : error);
  console.error(HELP);
  process.exitCode = 1;
});
