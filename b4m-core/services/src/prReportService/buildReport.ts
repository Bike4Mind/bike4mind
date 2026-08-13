/**
 * PR report generator - the renderer.
 *
 * A pure function of its inputs (display date aside), so the section logic is
 * testable without a provider. Buckets become ordered sections; empty sections are
 * omitted; a summary header reports totals.
 *
 * Two responsibilities the return type cannot express but which are load-bearing:
 *   - every interpolated value is escaped before the markup is assembled, so a
 *     crafted PR title cannot inject a mention or break formatting;
 *   - every active warning flag is rendered INTO the text, so the posted digest
 *     carries its own caveat instead of looking complete.
 */

import { bucketFor, priorityTierFor } from './bucketFor';
import { escapeSlackText, slackBold, slackItalic, slackLink, slackMention } from './slackMarkup';
import { PRIORITY_LABELS } from './bucketSpecs';
import type {
  Bucket,
  BucketSpec,
  BucketSpecs,
  GenerateReportWarnings,
  IdentityLookup,
  PriorityTier,
  PullRequest,
} from './types';

export interface BuildReportOptions {
  /** Injected for determinism in tests; defaults to now. */
  now?: Date;
  /** Fixed display timezone for the header date. */
  timeZone?: string;
}

const DEFAULT_TIME_ZONE = 'America/New_York';

/** Priority sub-group order: the labelled tiers, then the null "standard" tier last. */
const PRIORITY_ORDER: PriorityTier[] = [...PRIORITY_LABELS, null];

/**
 * Resolve the login accountable for a PR: the first assignee, else the author.
 *
 * An unmapped login renders as the plain escaped login rather than a broken
 * mention - visible to a reader, and honest about not notifying anyone.
 */
function ownerTag(pr: PullRequest, lookup: IdentityLookup): string | null {
  const login = pr.assigneeLogins[0] ?? pr.authorLogin;
  if (!login) return null;

  const memberId = lookup[login.toLowerCase()];
  return memberId ? slackMention(memberId) : escapeSlackText(login);
}

/**
 * The login of whoever is individually on the hook for THIS bucket's kind of work,
 * read from the field the bucket's spec names. This is the input the roster gate
 * tests - not assignment in general.
 */
function specificOwnerLogin(pr: PullRequest, spec: BucketSpec): string | null {
  if (spec.specificOwner === 'requestedReviewer') return pr.requestedReviewerLogins?.[0] ?? null;
  if (spec.specificOwner === 'assignee') return pr.assigneeLogins[0] ?? null;
  return null;
}

/** Tag a specific login through the roster path (mention when mapped, else plain). */
function loginTag(login: string, lookup: IdentityLookup): string {
  const memberId = lookup[login.toLowerCase()];
  return memberId ? slackMention(memberId) : escapeSlackText(login);
}

/** `#1738 Some title` as a link, with the title escaped. */
function prLine(pr: PullRequest, trailingTag: string | null): string {
  const link = slackLink(pr.url, `#${pr.number} ${pr.title}`);
  return trailingTag ? `• ${link} - ${trailingTag}` : `• ${link}`;
}

/** Newest first, a stable order that does not depend on provider page order. */
function byNumberDescending(a: PullRequest, b: PullRequest): number {
  return b.number - a.number;
}

function formatHeaderDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(now);
}

/**
 * Render one section's PR lines, sub-grouped by priority when the spec asks for it.
 */
function renderLines(prs: PullRequest[], spec: BucketSpec, lookup: IdentityLookup, isRoster: boolean): string[] {
  const lineFor = (pr: PullRequest): string => {
    if (!isRoster) return prLine(pr, ownerTag(pr, lookup));

    // In a roster section, a PR naming a specific individual tags THAT person -
    // through the roster path, not owner resolution. A PR naming nobody gets no
    // individual tag; the pool in the section header is what covers it.
    const login = specificOwnerLogin(pr, spec);
    return prLine(pr, login ? loginTag(login, lookup) : null);
  };

  if (!spec.subGroupByPriority) {
    return [...prs].sort(byNumberDescending).map(lineFor);
  }

  const lines: string[] = [];
  for (const tier of PRIORITY_ORDER) {
    const inTier = prs.filter(pr => priorityTierFor(pr) === tier).sort(byNumberDescending);
    if (!inTier.length) continue;

    // "standard" rather than "none" - `none` is the catch-all Bucket literal and
    // reusing it here would read as a bucket name.
    lines.push(slackItalic(tier ?? 'standard'));
    lines.push(...inTier.map(lineFor));
  }
  return lines;
}

/**
 * Build the digest.
 *
 * @param prs open PRs, already enriched with `isApproved` where available
 * @param identityLookup logins and role keys → Slack member ids
 * @param bucketSpecs one spec per bucket; drives order, titles and mentions
 * @param warnings degradation flags - each active one is rendered into the text
 */
export function buildReport(
  prs: PullRequest[],
  identityLookup: IdentityLookup,
  bucketSpecs: BucketSpecs,
  warnings: GenerateReportWarnings,
  options: BuildReportOptions = {}
): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  const grouped = new Map<Bucket, PullRequest[]>();
  for (const pr of prs) {
    const bucket = bucketFor(pr);
    const existing = grouped.get(bucket);
    if (existing) existing.push(pr);
    else grouped.set(bucket, [pr]);
  }

  const blocks: string[] = [];

  // Header. When the list was truncated the count is a floor, and the header says
  // so rather than printing a total it cannot stand behind.
  const countLabel = warnings.openPrListTruncated
    ? `${prs.length}+ open PRs (list truncated)`
    : `${prs.length} open PR${prs.length === 1 ? '' : 's'}`;
  blocks.push(`${slackBold('PR Status Digest')} - ${escapeSlackText(formatHeaderDate(now, timeZone))}\n${countLabel}`);

  // Advisory lines. These make the posted artifact self-describing: a channel
  // reader sees the caveat instead of a normal-looking digest that under-reports.
  const advisories: string[] = [];
  if (warnings.approvalDataUnavailable) {
    advisories.push(
      ':warning: Approval data was unavailable, so approved PRs may still appear under their review sections.'
    );
  }
  if (warnings.openPrListTruncated) {
    advisories.push(
      ':warning: The open-PR list hit its page bound - some PRs are omitted and the count above is a floor.'
    );
  }
  if (advisories.length) blocks.push(advisories.join('\n'));

  // Sections, in spec order. Empty ones are omitted entirely.
  const orderedBuckets = (Object.keys(bucketSpecs) as Bucket[]).sort(
    (a, b) => bucketSpecs[a].order - bucketSpecs[b].order
  );

  for (const bucket of orderedBuckets) {
    const inBucket = grouped.get(bucket);
    if (!inBucket?.length) continue;

    const spec = bucketSpecs[bucket];
    const isRoster = spec.mention === 'roleRoster';

    // The roster gate. The pool joins the header ONLY when at least one PR in the
    // section names nobody specific - so a fully-assigned section does not
    // blanket-ping everyone in the pool.
    let rosterTag = '';
    if (isRoster && spec.roleKey) {
      const anyUnassigned = inBucket.some(pr => !specificOwnerLogin(pr, spec));
      if (anyUnassigned) {
        const memberId = identityLookup[spec.roleKey.toLowerCase()];
        // An unresolved roleKey renders as nothing rather than a broken mention;
        // validateBucketSpecs is what catches it, at configuration time.
        if (memberId) rosterTag = ` ${slackMention(memberId)}`;
      }
    }

    const header = `${slackBold(escapeSlackText(spec.title))} (${inBucket.length})${rosterTag}`;
    blocks.push([header, ...renderLines(inBucket, spec, identityLookup, isRoster)].join('\n'));
  }

  return blocks.join('\n\n');
}
