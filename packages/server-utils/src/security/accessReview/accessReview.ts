import { z } from 'zod';

/**
 * Quarterly access review: the snapshot shape, the report and reminder text, and the cadence. The
 * reads live in ./accessReviewData.ts; the runbook is docs/security/quarterly-access-review.md.
 */

export const ACCESS_REVIEW_RUNBOOK = 'docs/security/quarterly-access-review.md';
export const STALE_API_KEY_DAYS = 90;

export type AccessReviewAccountStatus = 'active' | 'banned' | 'deleted';

export interface AccessReviewAdmin {
  userId: string;
  email: string | null;
  username: string | null;
  fullAdmin: boolean;
  permissions: string[];
  status: AccessReviewAccountStatus;
  lastActiveAt: string | null;
  activeSessions: number;
  trustedDevices: number;
  passkeys: number;
  oauthRefreshTokens: number;
  bridgeDevices: number;
  activeApiKeys: number;
}

/** Never carries the key secret, hash, digest or prefix. */
export interface AccessReviewApiKey {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerIsAdmin: boolean;
  scopes: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** An admin's live access to another account: a support access grant or an impersonation session. */
export interface AccessReviewDelegation {
  adminId: string;
  adminEmail: string | null;
  userId: string;
  startedAt: string | null;
  expiresAt: string | null;
}

export const ACCESS_REVIEW_COUNT_LABELS = {
  fullAdmins: 'Full admin accounts',
  delegatedAdmins: 'Delegated admin accounts',
  activeApiKeys: 'Active API keys',
  adminScopedApiKeys: 'Active API keys with the admin scope',
  adminOwnedApiKeys: 'Active API keys owned by admin accounts',
  apiKeysWithoutExpiry: 'Active API keys with no expiry',
  staleApiKeys: `Active API keys unused for ${STALE_API_KEY_DAYS} days`,
  activeSessions: 'Active sign-in sessions',
  impersonationSessions: 'Active impersonation sessions',
  supportAccessGrants: 'Active support access grants',
  trustedDevices: 'Trusted devices',
  passkeys: 'Passkeys',
  oauthGrants: 'OAuth app grants',
  oauthRefreshTokens: 'OAuth refresh tokens',
  bridgeDevices: 'Paired bridge devices',
} as const;

export type AccessReviewCounts = Record<keyof typeof ACCESS_REVIEW_COUNT_LABELS, number>;

export interface AccessReviewSnapshot {
  quarter: string;
  generatedAt: string;
  /** False when the key list holds only privileged keys (admin-owned or admin-scoped). */
  allApiKeysListed: boolean;
  counts: AccessReviewCounts;
  admins: AccessReviewAdmin[];
  apiKeys: AccessReviewApiKey[];
  supportAccess: AccessReviewDelegation[];
  impersonation: AccessReviewDelegation[];
}

/** The counts of a snapshot written earlier; tolerant of count keys added or removed since. */
export interface AccessReviewBaseline {
  quarter: string;
  generatedAt: string;
  counts: Partial<Record<string, number>>;
}

const baselineSchema = z.object({
  quarter: z.string(),
  generatedAt: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

export function parseAccessReviewBaseline(value: unknown): AccessReviewBaseline {
  const parsed = baselineSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Baseline is not an access review snapshot (expected quarter, generatedAt, counts)');
  return parsed.data;
}

export const reviewQuarter = (date: Date): string =>
  `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;

/** The first Monday (UTC) of January, April, July and October: one day per quarter for a daily cron. */
export const isAccessReviewReminderDay = (date: Date): boolean =>
  date.getUTCMonth() % 3 === 0 && date.getUTCDate() <= 7 && date.getUTCDay() === 1;

const cell = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '-' : String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');

const table = (headers: string[], rows: Array<Array<string | number | null>>): string[] =>
  rows.length === 0
    ? ['None.']
    : [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
      ];

const DECISION_HEADERS = ['Decision (keep/revoke)', 'Decided by'];

const change = (now: number, before: number | undefined): string => {
  if (before === undefined) return '-';
  const delta = now - before;
  return delta > 0 ? `+${delta}` : String(delta);
};

function countsTable(counts: AccessReviewCounts, baseline?: AccessReviewBaseline): string[] {
  const entries = Object.entries(ACCESS_REVIEW_COUNT_LABELS) as Array<[keyof AccessReviewCounts, string]>;
  if (!baseline)
    return table(
      ['Access', 'Count'],
      entries.map(([key, label]) => [label, counts[key]])
    );
  return table(
    ['Access', `Before (${baseline.quarter}, ${day(baseline.generatedAt)})`, 'After', 'Change'],
    entries.map(([key, label]) => [
      label,
      baseline.counts[key] ?? null,
      counts[key],
      change(counts[key], baseline.counts[key]),
    ])
  );
}

const delegationRows = (rows: AccessReviewDelegation[]) =>
  rows.map(row => [row.adminEmail ?? row.adminId, row.userId, day(row.startedAt), day(row.expiresAt), '', '']);

/**
 * The review record: counts (with before/after when a baseline is given) and one row per grant of
 * privileged access, with blank decision columns the reviewer fills in before filing it.
 */
export function formatAccessReviewMarkdown(snapshot: AccessReviewSnapshot, baseline?: AccessReviewBaseline): string {
  const { counts, admins, apiKeys, supportAccess, impersonation } = snapshot;
  const keyHeading = snapshot.allApiKeysListed ? 'Active API keys' : 'Privileged API keys';
  const keyScope = snapshot.allApiKeysListed
    ? 'Every active, unexpired API key.'
    : 'Active, unexpired keys owned by an admin account or carrying the admin scope. The counts above cover every key.';
  return [
    `# Access review ${snapshot.quarter}`,
    '',
    `Generated ${snapshot.generatedAt} from the app database (read-only). Fill in each Decision and Decided by, revoke what was decided, then re-run with this snapshot as the baseline to record the after counts. Runbook: ${ACCESS_REVIEW_RUNBOOK}.`,
    '',
    'Reviewer: ',
    'Review completed (date): ',
    '',
    '## Counts',
    '',
    ...countsTable(counts, baseline),
    '',
    `## Admin accounts (${admins.length})`,
    '',
    ...table(
      [
        'User',
        'Email',
        'Status',
        'Access',
        'Last active',
        'Sessions',
        'Trusted devices',
        'Passkeys',
        'OAuth tokens',
        'Bridge devices',
        'API keys',
        ...DECISION_HEADERS,
      ],
      admins.map(admin => [
        admin.username ?? admin.userId,
        admin.email,
        admin.status,
        admin.fullAdmin ? 'full admin' : admin.permissions.join(', '),
        day(admin.lastActiveAt),
        admin.activeSessions,
        admin.trustedDevices,
        admin.passkeys,
        admin.oauthRefreshTokens,
        admin.bridgeDevices,
        admin.activeApiKeys,
        '',
        '',
      ])
    ),
    '',
    `## ${keyHeading} (${apiKeys.length})`,
    '',
    keyScope,
    '',
    ...table(
      ['Key id', 'Name', 'Owner', 'Owner is admin', 'Scopes', 'Created', 'Last used', 'Expires', ...DECISION_HEADERS],
      apiKeys.map(key => [
        key.id,
        key.name,
        key.ownerEmail ?? key.ownerId,
        key.ownerIsAdmin ? 'yes' : 'no',
        key.scopes.join(', ') || null,
        day(key.createdAt),
        day(key.lastUsedAt),
        key.expiresAt ? day(key.expiresAt) : 'never',
        '',
        '',
      ])
    ),
    '',
    `## Active support access (${supportAccess.length})`,
    '',
    ...table(['Admin', 'User id', 'Started', 'Expires', ...DECISION_HEADERS], delegationRows(supportAccess)),
    '',
    `## Active impersonation sessions (${impersonation.length})`,
    '',
    ...table(['Admin', 'User id', 'Started', 'Expires', ...DECISION_HEADERS], delegationRows(impersonation)),
    '',
    '## Revocations',
    '',
    '| What was revoked | Revoked by | When | Note |',
    '| --- | --- | --- | --- |',
    '| | | | |',
  ].join('\n');
}

/** Slack mrkdwn for the quarterly reminder: counts only, the per-account detail stays in the report. */
export function formatAccessReviewSlackMessage(snapshot: Pick<AccessReviewSnapshot, 'quarter' | 'counts'>): string {
  const entries = Object.entries(ACCESS_REVIEW_COUNT_LABELS) as Array<[keyof AccessReviewCounts, string]>;
  return [
    `:clipboard: *Quarterly access review due: ${snapshot.quarter}*`,
    'Privileged access in the app database right now:',
    ...entries.map(([key, label]) => `- ${label}: ${snapshot.counts[key]}`),
    `Enumerate, decide keep or revoke for each grant, revoke, then re-run for the after counts and file the report. Runbook: \`${ACCESS_REVIEW_RUNBOOK}\``,
  ].join('\n');
}
