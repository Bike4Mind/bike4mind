import { parseArgs } from 'node:util';

export const HELP_TEXT = `Quarterly access review: a read-only snapshot of privileged access in the app database.

Lists admin accounts (full and delegated) with their sessions, devices and API keys, privileged API
keys, live support access and impersonation, and counts every active grant. The Markdown carries
blank Decision and Decided by columns for the reviewer. Never reads key secrets or hashes.

Options:
  --out <file>        Write the Markdown report here instead of stdout.
  --json <file>       Also write the snapshot as JSON (keep it as the baseline for the after run).
  --baseline <file>   A JSON snapshot from earlier; adds before, after and change columns to the counts.
  --all-keys          List every active API key, not only admin-owned and admin-scoped ones.
  -h, --help          Show this help.

Runbook: docs/security/quarterly-access-review.md`;

export interface AccessReviewArgs {
  help: boolean;
  out?: string;
  json?: string;
  baseline?: string;
  allKeys: boolean;
}

export function parseAccessReviewArgs(args: string[]): AccessReviewArgs {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      out: { type: 'string' },
      json: { type: 'string' },
      baseline: { type: 'string' },
      'all-keys': { type: 'boolean', default: false },
    },
    strict: true,
  });
  return {
    help: values.help,
    out: values.out,
    json: values.json,
    baseline: values.baseline,
    allKeys: values['all-keys'],
  };
}
