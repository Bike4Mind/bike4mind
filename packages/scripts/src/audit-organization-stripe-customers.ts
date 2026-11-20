#!/usr/bin/env tsx

/**
 * Read-only audit, including soft-deleted organizations. No Stripe calls or database writes.
 * Run in an authorized SST shell:
 *   pnpm --filter @bike4mind/scripts audit:organization-stripe-customers --report /tmp/org-customers.json
 * Keep the report outside the repository: it contains organization and customer identifiers.
 * Record the stage, audit time and duplicate count privately; resolve duplicates before adding
 * any unique index. This command reports findings only and never repairs them.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: { report: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    console.log('Read-only, including soft-deleted organizations. Usage: --report /tmp/org-customers.json');
    return;
  }
  if (!values.report) throw new Error('--report <path outside the repository> is required');
  const reportPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.report);

  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { auditOrganizationStripeCustomers } = await import('./auditOrganizationStripeCustomers');
  const mongoose = (await import('mongoose')).default;
  const stage = Resource.App.stage;

  try {
    await connectDB((process.env.MONGODB_URI ?? Config.MONGODB_URI).replace('%STAGE%', stage), undefined, {
      autoIndex: false,
      autoCreate: false,
    });
    const startedAt = new Date().toISOString();
    const duplicates = await auditOrganizationStripeCustomers();
    const report = {
      stage,
      startedAt,
      completedAt: new Date().toISOString(),
      includesDeleted: true,
      scope: 'All organizations with a non-empty string stripeCustomerId',
      duplicateCustomerCount: duplicates.length,
      duplicates,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Stage: ${stage}; duplicate customers: ${duplicates.length}; report: ${reportPath}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('[audit-organization-stripe-customers] failed:', error);
  process.exitCode = 1;
});
