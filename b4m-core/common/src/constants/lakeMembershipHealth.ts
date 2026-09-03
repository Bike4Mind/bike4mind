/**
 * The MEMBERSHIP dimension of lake health (#2245), alongside the content dimension in lakeHealth.ts.
 *
 * Content health asks "can this member be retrieved"; every predicate there can pass on a lake that
 * carries two upload generations of the same documents, because each generation genuinely is chunked
 * and vectorized. This module asks the other question: WHICH members are here, by what right, and are
 * any of them the same document twice.
 *
 * Pure, like `summarizeLakeHealth`: no I/O, no repository, so the bucketing rules are testable
 * against literals and cannot drift into a query. Report-only - it describes, and `planLakeMembership
 * Repair` decides what to do about it.
 */

/**
 * How a member reaches this lake. Both are supported shapes, NOT a defect axis: a prefix-arm join
 * makes a file a member with no `datalake:*` meta-tag involved (see toggleTags.ts). The split is a
 * SCOPE disclosure - the prefix arm is anchored to the lake's creator, so a prefix-only member is
 * reachable by retrieval only for principals that arm admits.
 */
export const MEMBERSHIP_ARMS = ['meta-tag', 'prefix'] as const;
export type MembershipArm = (typeof MEMBERSHIP_ARMS)[number];

/**
 * How confidently two members carrying one name can be called the same document.
 *
 * Ordered by how much human judgment each needs, which is also the order the plan presents them in.
 */
export const DUPLICATE_BUCKETS = ['proven-identical', 'differing', 'unverified'] as const;
export type DuplicateBucket = (typeof DUPLICATE_BUCKETS)[number];

export interface LakeMembershipMemberInput {
  fabFileId: string;
  fileName?: string | null;
  /**
   * Tri-state, and the distinction is load-bearing (see FabFileTypes): a hex string is a fingerprint
   * over normalized extracted text; `null` means "chunked, and there was no extractable text";
   * `undefined` means "never chunked". Only the hex form can prove identity - see `isFingerprint`.
   */
  serverTextHash?: string | null;
  fileSize?: number | null;
  createdAt?: Date | null;
  arm: MembershipArm;
}

export interface DuplicateGroupMember {
  fabFileId: string;
  serverTextHash: string | null;
  fileSize: number | null;
  createdAt: Date | null;
  arm: MembershipArm;
}

export interface DuplicateGroup {
  fileName: string;
  bucket: DuplicateBucket;
  /** Newest first, so "keep newest" is `members[0]` at every reading surface. Capped by the caller. */
  members: DuplicateGroupMember[];
  /**
   * Members in this group even when `members` is capped, so no reader can be told there are fewer -
   * the same discipline `affectedMemberCount` keeps beside `affectedMembers`. `bucket` is classified
   * over the WHOLE group before the cap, so a capped group is not mis-bucketed.
   */
  memberCount: number;
}

/**
 * The principal every membership number below was computed as, stated rather than implied.
 *
 * This exists because "75 files" and "Reachable 100%" were both true AS THE CREATOR and neither said
 * so, which is how a lake with a third of it unreachable to its readers looked healthy (#2243). A
 * number without its scope is the defect, not a presentation detail.
 */
export interface MembershipScopeDisclosure {
  /** The user id the prefix arm was anchored to, or null for a registry lake (open prefix arm). */
  creatorUserId: string | null;
  /** Null when the lake has no prefix arm at all, in which case `prefix` below is always 0. */
  fileTagPrefix: string | null;
}

export interface LakeMembershipReport {
  scope: MembershipScopeDisclosure;
  /** Members the caller SCANNED, not the lake's true total - a lower bound when `scanTruncated`. */
  totalMembers: number;
  /** Not a pass/fail split - see MEMBERSHIP_ARMS. */
  armSplit: Record<MembershipArm, number>;
  /** Distinct file names carried by more than one member. */
  duplicateNameCount: number;
  /** Members sitting in those groups, INCLUDING the copy that would be kept. */
  duplicateMemberCount: number;
  /** How many groups fell into each bucket, so a caller can size the review queue without walking. */
  bucketCounts: Record<DuplicateBucket, number>;
  /** Worst-first: unverified, then differing, then proven-identical; capped by the caller. */
  duplicateGroups: DuplicateGroup[];
  /**
   * True when the caller's member scan was bounded, so every count here is a lower bound.
   *
   * Which end was cut matters and is not symmetric: the scan is `_id`-ascending, so the members
   * OUTSIDE the window are the newest - and a fresh re-upload generation is exactly what this
   * dimension hunts. A group with one member inside the window and its twin outside is not reported
   * as a duplicate at all. Read this flag as "the newest members are missing", not merely "some are".
   */
  scanTruncated: boolean;
}

/**
 * Whether a `serverTextHash` value can PROVE anything: a RECORDED hash, as opposed to `null` or
 * absent. It does not validate the encoding - any non-empty string passes.
 *
 * `null` is the trap: it is a recorded fact ("chunked, no extractable text"), not a missing value, so
 * it is tempting to compare two of them for equality - but every image, every scan and every empty
 * document in a lake carries `null`, and calling those identical would auto-collapse unrelated files
 * into one another. Absence and `null` therefore mean the same thing HERE even though they mean
 * different things in the datastore: identity is unproven.
 *
 * Deliberately not a hex validator. The only producer is the internal hashing pipeline
 * (`computeServerTextHash`), so a format check would buy nothing and would add a failure mode - a
 * future hash encoding, or a truncated value, silently reclassified as "unproven" rather than
 * flagged. If this ever receives less-trusted input, validate at that boundary, not here.
 */
export function isFingerprint(hash: string | null | undefined): hash is string {
  return typeof hash === 'string' && hash.length > 0;
}

/**
 * Newest first; a member with no `createdAt` sorts last, since it cannot be shown to be newer.
 *
 * Exported because `members` order is load-bearing downstream: `lakeMembershipRepair` removes by
 * position ("everything after the first"), so an executor that re-reads members from Mongo in natural
 * order has to restore THIS order - including the no-`createdAt` rule and the id tie-break - or it
 * deletes the wrong copy. Re-implementing it is the failure mode; sharing it is the fix.
 */
export function byNewestFirst(a: DuplicateGroupMember, b: DuplicateGroupMember): number {
  const at = a.createdAt?.getTime();
  const bt = b.createdAt?.getTime();
  if (at === undefined && bt === undefined) return a.fabFileId.localeCompare(b.fabFileId);
  if (at === undefined) return 1;
  if (bt === undefined) return -1;
  // Tie-break on id so a group of same-second uploads orders reproducibly across runs, which is
  // what makes a plan stable enough to compare to the one the owner already reviewed.
  return bt - at || a.fabFileId.localeCompare(b.fabFileId);
}

/**
 * Which bucket a same-name group belongs to.
 *
 * `proven-identical` requires EVERY member to carry the same hex fingerprint AND a KNOWN, matching
 * `fileSize`. The size conjunct is a judgment call worth stating: the hash covers normalized
 * extracted TEXT, so two files can share it while differing in bytes (a re-export, a different
 * encoding, an added image). Auto-collapse is the only bucket that mutates membership without asking
 * anyone, so it is the one place to be stricter than the issue's wording and let a size disagreement
 * fall to `differing` for a human.
 *
 * `fileSize` is optional on the schema and the read coalesces an absent one to `null`, so requiring
 * it to be a NUMBER is the same rule `isFingerprint` applies to the hash: a missing value is never
 * compared for equality. Without that, two size-less members satisfied `null === null` and the
 * conjunct went vacuous exactly where it cannot discriminate - on the re-export case it exists to
 * catch - handing the collapse arm a group it was never meant to be given.
 */
function classifyGroup(members: DuplicateGroupMember[]): DuplicateBucket {
  if (!members.every(m => isFingerprint(m.serverTextHash))) return 'unverified';
  const [first, ...rest] = members;
  const sameHash = rest.every(m => m.serverTextHash === first.serverTextHash);
  const sameSize = typeof first.fileSize === 'number' && rest.every(m => m.fileSize === first.fileSize);
  return sameHash && sameSize ? 'proven-identical' : 'differing';
}

/** Worst-first: the buckets needing a human come before the one that collapses itself. */
const BUCKET_ORDER: Record<DuplicateBucket, number> = { unverified: 0, differing: 1, 'proven-identical': 2 };

/**
 * Group a lake's members by file name and bucket the collisions.
 *
 * Grouping is by EXACT name. Not normalized case, not trimmed: a lake holding `Report.pdf` and
 * `report.pdf` may well hold two documents, and inventing a match here would put unrelated files in
 * front of an owner as a duplicate pair - the one error this report cannot afford, because acting on
 * it removes membership.
 */
export function summarizeLakeMembership(
  members: LakeMembershipMemberInput[],
  options: {
    scope: MembershipScopeDisclosure;
    scanTruncated?: boolean;
    maxGroups?: number;
    /** Per-group member cap. Capping groups alone leaves the payload bounded only by the scan limit. */
    maxGroupMembers?: number;
  }
): LakeMembershipReport {
  const armSplit: Record<MembershipArm, number> = { 'meta-tag': 0, prefix: 0 };
  const byName = new Map<string, DuplicateGroupMember[]>();

  for (const member of members) {
    armSplit[member.arm] += 1;
    // A member with no name cannot collide by name. Counted in the totals and the arm split, since
    // it is genuinely a member, but it can never be proposed for removal on a name match.
    if (!member.fileName) continue;
    const entry: DuplicateGroupMember = {
      fabFileId: member.fabFileId,
      serverTextHash: isFingerprint(member.serverTextHash) ? member.serverTextHash : null,
      fileSize: typeof member.fileSize === 'number' ? member.fileSize : null,
      createdAt: member.createdAt ?? null,
      arm: member.arm,
    };
    const existing = byName.get(member.fileName);
    if (existing) existing.push(entry);
    else byName.set(member.fileName, [entry]);
  }

  const bucketCounts: Record<DuplicateBucket, number> = { 'proven-identical': 0, differing: 0, unverified: 0 };
  let duplicateMemberCount = 0;
  const groups: DuplicateGroup[] = [];

  for (const [fileName, entries] of byName) {
    if (entries.length < 2) continue;
    entries.sort(byNewestFirst);
    // Bucketed and counted over the whole group, then capped: the cap bounds the payload and must
    // not change what the group IS. Sorted first, so a capped array keeps the newest members - the
    // ones "keep newest" reads and a reviewer needs.
    const bucket = classifyGroup(entries);
    bucketCounts[bucket] += 1;
    duplicateMemberCount += entries.length;
    groups.push({
      fileName,
      bucket,
      members: options.maxGroupMembers === undefined ? entries : entries.slice(0, options.maxGroupMembers),
      memberCount: entries.length,
    });
  }

  // Sort before the cap, so a truncated report carries the groups a human most needs to see rather
  // than whichever names happened to hash first.
  groups.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || a.fileName.localeCompare(b.fileName));

  return {
    scope: options.scope,
    totalMembers: members.length,
    armSplit,
    duplicateNameCount: groups.length,
    duplicateMemberCount,
    bucketCounts,
    duplicateGroups: options.maxGroups === undefined ? groups : groups.slice(0, options.maxGroups),
    scanTruncated: options.scanTruncated ?? false,
  };
}
