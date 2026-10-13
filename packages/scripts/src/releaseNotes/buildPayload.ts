import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { RELEASE_NOTES_SCHEMA_VERSION, type ReleaseNotesJobPayload, type ReleaseNotesJobPr } from '@bike4mind/common';
import { extractPRNumber } from '../generateChangelog';
import { resolveCommitSha, type GitHubCommit, type GitHubRelease, type PRSummary } from '../utils/githubApi';

export const PRODUCTION_TAG = /^v\d+\.\d+\.\d+\.\d+$/;
export const EXCERPT_CHARS = 500;
// Matches the editorial summary cap; author notes skip triage, so they are bounded here.
export const CUSTOMER_NOTE_CHARS = 600;
// SQS caps a message at 256 KiB; leave headroom for attributes and encoding.
export const MAX_PAYLOAD_BYTES = 240_000;
// Excerpts go first; customer notes are only shortened, never dropped, as the last resort.
const SIZE_TIERS = [
  { excerpt: EXCERPT_CHARS, note: CUSTOMER_NOTE_CHARS },
  { excerpt: 200, note: CUSTOMER_NOTE_CHARS },
  { excerpt: 0, note: CUSTOMER_NOTE_CHARS },
  { excerpt: 0, note: 200 },
];

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const CUSTOMER_NOTE_HEADING = /^##\s+customer note\s*$/im;
const PLACEHOLDER_NOTE = /^(n\/?a|none|-+)$/i;

/**
 * The `## Customer note` section of a PR description, cut to `CUSTOMER_NOTE_CHARS`, or undefined when it
 * is absent, empty or a placeholder.
 */
export function parseCustomerNote(body: string): string | undefined {
  const heading = CUSTOMER_NOTE_HEADING.exec(body);
  if (!heading) return undefined;
  const rest = body.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^#{1,2}\s/m);
  const note = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).replace(HTML_COMMENT, '').trim();
  return note && !PLACEHOLDER_NOTE.test(note) ? note.slice(0, CUSTOMER_NOTE_CHARS) : undefined;
}

/** PR description with template comments stripped and whitespace collapsed, cut to `maxChars`. */
export function excerptDescription(body: string, maxChars = EXCERPT_CHARS): string {
  const text = body.replace(HTML_COMMENT, '').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

const payloadBytes = (p: ReleaseNotesJobPayload): number => Buffer.byteLength(JSON.stringify(p), 'utf8');

/**
 * Shrinks PR excerpts (500, then 200, then none), then customer notes (to 200), until the payload fits in
 * `maxBytes`. Throws when it still does not fit, since dropping PRs would silently lose content.
 */
export function capPayloadSize(payload: ReleaseNotesJobPayload, maxBytes = MAX_PAYLOAD_BYTES): ReleaseNotesJobPayload {
  for (const tier of SIZE_TIERS) {
    const capped = {
      ...payload,
      prs: payload.prs.map(pr => ({
        ...pr,
        excerpt: pr.excerpt.slice(0, tier.excerpt),
        ...(pr.customerNote === undefined ? {} : { customerNote: pr.customerNote.slice(0, tier.note) }),
      })),
    };
    if (payloadBytes(capped) <= maxBytes) return capped;
  }
  throw new Error(
    `release notes payload for ${payload.releaseTag} exceeds ${maxBytes} bytes even with excerpts and notes trimmed`
  );
}

export interface PayloadDeps {
  getCommitRange: (base: string, head: string) => Promise<GitHubCommit[]>;
  getPRSummary: (prNumber: number) => Promise<PRSummary | null>;
  resolveCommitSha?: (ref: string) => Promise<string>;
}

/**
 * Builds the job payload for `release`, covering the PRs merged since `previousTag`. `deployedAt` anchors
 * the embargo and defaults to now: CI enqueues right after the deploy, and a backfilled release gets a
 * fresh embargo. GitHub's `created_at` is the release commit's date, not the deploy time.
 */
export async function buildReleaseNotesPayload(
  release: Pick<GitHubRelease, 'tag_name' | 'html_url' | 'target_commitish'>,
  previousTag: string | null,
  deps: PayloadDeps,
  deployedAt: Date = new Date()
): Promise<ReleaseNotesJobPayload> {
  const commits = previousTag ? await deps.getCommitRange(previousTag, release.tag_name) : [];
  const numbers = [...new Set(commits.map(c => extractPRNumber(c.message)).filter((n): n is number => n !== null))];
  numbers.sort((a, b) => a - b);

  const prs: ReleaseNotesJobPr[] = [];
  for (const number of numbers) {
    const pr = await deps.getPRSummary(number);
    if (!pr) continue;
    const customerNote = parseCustomerNote(pr.body);
    prs.push({
      number,
      title: pr.title,
      labels: pr.labels,
      ...(customerNote ? { customerNote } : {}),
      excerpt: excerptDescription(pr.body),
    });
  }

  // Releases created in the GitHub UI carry the target branch name, not a sha.
  const deployedSha = /^[0-9a-f]{40}$/i.test(release.target_commitish)
    ? release.target_commitish
    : await (deps.resolveCommitSha ?? resolveCommitSha)(release.tag_name);

  return capPayloadSize({
    kind: 'release-notes',
    schemaVersion: RELEASE_NOTES_SCHEMA_VERSION,
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    previousTag,
    deployedSha,
    deployedAt,
    prs,
  });
}

/** Production releases oldest first, each paired with the production release before it (null for the first). */
export function pairAdjacentReleases(
  releases: GitHubRelease[]
): Array<{ release: GitHubRelease; previousTag: string | null }> {
  const ordered = releases
    .filter(r => PRODUCTION_TAG.test(r.tag_name))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return ordered.map((release, i) => ({ release, previousTag: i > 0 ? ordered[i - 1].tag_name : null }));
}

/** Pairs whose release was created within [since, until]; either bound may be omitted. */
export function selectBackfillPairs(releases: GitHubRelease[], since?: Date, until?: Date) {
  return pairAdjacentReleases(releases).filter(({ release }) => {
    const at = Date.parse(release.created_at);
    return (!since || at >= since.getTime()) && (!until || at <= until.getTime());
  });
}

export async function enqueueReleaseNotes(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
  payload: ReleaseNotesJobPayload
): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(payload) }));
}
