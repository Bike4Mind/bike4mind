#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { baselineRules, baselineWindowSchema } from '@bike4mind/server-utils/analytics/signupBaseline';

const HELP = `Read-only signup baseline and account census (JSON).

Usage: report:signup-baseline --since <ISO UTC> [--until <ISO UTC>] [--test-pattern <regex>]

--since is inclusive and --until exclusive (default: now). Use the agreed post-fix cutoff.
Set NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS; missing staff exclusions abort the report.
Optional ANALYTICS_TEST_PATTERN supplies the same test-email regex to the CLI and weekly job.
No prompt content, event metadata or email addresses appear in the report.
Historical starting balances are unknown; recorded first-day signup grants are reported separately.
`;

async function main() {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      'test-pattern': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const date = z.iso.datetime().transform(value => new Date(value));
  const window = baselineWindowSchema.parse({
    since: date.parse(values.since),
    until: values.until ? date.parse(values.until) : new Date(),
  });
  const staffDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  const testPattern = values['test-pattern'] ?? process.env.ANALYTICS_TEST_PATTERN;
  baselineRules(staffDomains, testPattern);

  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { runSignupBaselineReport } = await import('@bike4mind/server-utils/analytics/signupBaselineReport');
  const mongoose = (await import('mongoose')).default;
  try {
    const uri = process.env.MONGODB_URI ?? Config.MONGODB_URI;
    await connectDB(uri.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await runSignupBaselineReport({ ...window, staffDomains, testPattern }), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[signup-baseline] failed:', error);
  process.exitCode = 1;
});
