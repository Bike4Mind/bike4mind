import { sourceIdentityKeyFor, type SourceIdentityTier } from './sourceIdentity';

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
  /**
   * Who uploaded this member. Neither membership arm carries an ownership conjunct, so a group can
   * span contributors - see the note on DuplicateGroupMember.userId.
   */
  userId?: string | null;
  arm: MembershipArm;
  /**
   * The two stronger source-identity signals, read only to SPLIT a same-name group - see
   * `buildDuplicateGroups`. Optional because most doors have neither: a plain single-file upload
   * carries no `relativePath` and no `driveFileId`, and a group of those falls to the file-name
   * tier, which is the behaviour this report had before they existed.
   */
  relativePath?: string | null;
  driveFileId?: string | null;
}

export interface DuplicateGroupMember {
  fabFileId: string;
  serverTextHash: string | null;
  fileSize: number | null;
  createdAt: Date | null;
  /**
   * The uploader, carried because a same-name group can span two of them and the repair arm must be
   * able to notice. The meta-tag arm matches on the tag alone and a registry lake's prefix arm has no
   * ownership conjunct either, so any principal's file bearing the lake's tag is a member: two
   * contributors can upload the same document, bucket `proven-identical`, and have one proposed for
   * removal. A plan that cannot see the survivor and the casualty have different owners cannot gate
   * on it. Null when the owner is unknown, which is never grounds to collapse.
   *
   * In-process only - stripped at the API boundary by `toWireMembershipReport`.
   */
  userId: string | null;
  arm: MembershipArm;
  /**
   * Carried through the conversion purely so the identity refinement can run on a NEWEST-FIRST
   * array (`byNewestFirst` sorts this type, not the raw input). Stripped at the API boundary by
   * `toWireMembershipReport` - a `relativePath` is a slice of the uploader's local folder tree and a
   * `driveFileId` addresses a document in their Drive, and this payload's audience is every reader
   * of the lake, not its owner.
   */
  relativePath: string | null;
  driveFileId: string | null;
}

export interface DuplicateGroup {
  fileName: string;
  bucket: DuplicateBucket;
  /**
   * Which identity signal established that these members are generations of ONE document. Reported
   * because `fileName` - the weakest tier - is the one that can be wrong, and a reader deciding
   * whether to act on a pair can only tell that from the tier.
   */
  tier: SourceIdentityTier;
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
 *
 * An ABSENT size is not a size disagreement, though, and the two land in different buckets. Matching
 * fingerprints with a size nobody recorded is "cannot tell" (`unverified`), not "these are different
 * documents" (`differing`) - only a measured disagreement earns the latter. Both keep the group out
 * of auto-collapse, which is what the strictness is for; routing an unknown to `differing` would have
 * the report assert something it never established.
 */
function classifyGroup(members: DuplicateGroupMember[]): DuplicateBucket {
  if (!members.every(m => isFingerprint(m.serverTextHash))) return 'unverified';
  const [first, ...rest] = members;
  if (!rest.every(m => m.serverTextHash === first.serverTextHash)) return 'differing';
  if (!members.every(m => typeof m.fileSize === 'number')) return 'unverified';
  return rest.every(m => m.fileSize === first.fileSize) ? 'proven-identical' : 'differing';
}

/** Worst-first: the buckets needing a human come before the one that collapses itself. */
const BUCKET_ORDER: Record<DuplicateBucket, number> = { unverified: 0, differing: 1, 'proven-identical': 2 };

/** The reported projection of one scanned member. Absence and `null` are folded here, not later. */
function toDuplicateGroupMember(member: LakeMembershipMemberInput): DuplicateGroupMember {
  return {
    fabFileId: member.fabFileId,
    serverTextHash: isFingerprint(member.serverTextHash) ? member.serverTextHash : null,
    fileSize: typeof member.fileSize === 'number' ? member.fileSize : null,
    createdAt: member.createdAt ?? null,
    userId: member.userId ?? null,
    arm: member.arm,
    relativePath: member.relativePath ?? null,
    driveFileId: member.driveFileId ?? null,
  };
}

/**
 * Narrow a same-name group to the members that are generations of the SAME source document, keyed
 * off the NEWEST member - the generation every decision in this lane is expressed relative to
 * ("keep newest", "the copy that displaced it").
 *
 * The scope key is `''` because the caller has already narrowed to one lake, so every member here
 * shares a partition and adding an id would only lengthen the key. Never pass a set spanning lakes.
 *
 * Null when the group is empty or its name is, so no member was compared against anything.
 * Unreachable through `buildDuplicateGroups`, which skips a nameless member and never builds a group
 * under an empty key - returning null rather than asserting keeps a future caller with a laxer input
 * from getting a group whose members were compared against nothing.
 */
function membersSharingNewestIdentity(
  fileName: string,
  newestFirst: readonly DuplicateGroupMember[]
): { members: DuplicateGroupMember[]; tier: SourceIdentityTier } | null {
  // `fileName` comes from the group key, not from the member: the name is the thing every member
  // here shares, so it is stored once on the group rather than repeated on each row.
  const identityOf = (m: DuplicateGroupMember) =>
    sourceIdentityKeyFor({ fileName, relativePath: m.relativePath, driveFileId: m.driveFileId }, '');
  const newest = newestFirst[0] && identityOf(newestFirst[0]);
  if (!newest) return null;
  return {
    members: newestFirst.filter(m => identityOf(m)?.key === newest.key),
    tier: newest.tier,
  };
}

/**
 * Group a lake's members by file name, then narrow each collision to the members that really are one
 * document, and bucket what survives.
 *
 * Grouping is by EXACT name. Not normalized case, not trimmed: a lake holding `Report.pdf` and
 * `report.pdf` may well hold two documents, and inventing a match here would put unrelated files in
 * front of an owner as a duplicate pair - the one error this report cannot afford, because acting on
 * it removes membership.
 *
 * The name is the OUTER key and the identity refinement only ever narrows within it, which is a
 * constraint rather than an implementation detail: the owner's ruling is stored against
 * `(dataLakeId, fileName)` (ILakeMembershipDecision) and `groupIdentity` is computed over whatever
 * members a group ends up holding. Splitting one name into two groups would give two groups one
 * tombstone key and let a ruling about one pair settle the other; so a name yields at most one
 * group, holding the newest generation and the members sharing its identity. Two `README.md` files
 * at different `relativePath`s are therefore not reported as duplicates at all - which is the point,
 * since collapsing them is the false pair the file-name tier is known to produce.
 *
 * Exported so the admission checkpoint's same-identity detection
 * (`detectSameIdentityAdmission`) grades a fresh member through this exact function. Two
 * implementations of "same document, and how confidently" would let the offer made at upload time
 * disagree with the plan the owner sees afterwards, about the same pair.
 */
export function buildDuplicateGroups(members: readonly LakeMembershipMemberInput[]): {
  groups: DuplicateGroup[];
  duplicateMemberCount: number;
  bucketCounts: Record<DuplicateBucket, number>;
} {
  const byName = new Map<string, DuplicateGroupMember[]>();
  for (const member of members) {
    // A member with no name cannot collide by name. Still a member (the caller counts it in the
    // totals and the arm split), but it can never be proposed for removal on a name match.
    if (!member.fileName) continue;
    const existing = byName.get(member.fileName);
    if (existing) existing.push(toDuplicateGroupMember(member));
    else byName.set(member.fileName, [toDuplicateGroupMember(member)]);
  }

  const bucketCounts: Record<DuplicateBucket, number> = { 'proven-identical': 0, differing: 0, unverified: 0 };
  let duplicateMemberCount = 0;
  const groups: DuplicateGroup[] = [];

  for (const [fileName, entries] of byName) {
    if (entries.length < 2) continue;
    // Sorted BEFORE the refinement, because the refinement is anchored to the newest member.
    entries.sort(byNewestFirst);
    const sameIdentity = membersSharingNewestIdentity(fileName, entries);
    // A name shared by members the identity key proves are different documents is not a duplicate.
    if (!sameIdentity || sameIdentity.members.length < 2) continue;
    // Bucketed and counted over the whole refined group; the caller's cap bounds the payload and
    // must not change what the group IS.
    const bucket = classifyGroup(sameIdentity.members);
    bucketCounts[bucket] += 1;
    duplicateMemberCount += sameIdentity.members.length;
    groups.push({
      fileName,
      bucket,
      tier: sameIdentity.tier,
      members: sameIdentity.members,
      memberCount: sameIdentity.members.length,
    });
  }

  // Sorted here rather than by the caller, so every reader of this function gets worst-first and a
  // truncated report carries the groups a human most needs to see rather than whichever names
  // happened to hash first.
  groups.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || a.fileName.localeCompare(b.fileName));

  return { groups, duplicateMemberCount, bucketCounts };
}

/** Group a lake's members, bound the payload, and stamp the scope every number was computed as. */
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
  for (const member of members) {
    armSplit[member.arm] += 1;
  }

  const { groups, duplicateMemberCount, bucketCounts } = buildDuplicateGroups(members);
  // Capped AFTER grouping, and `memberCount` above stays exact, so no reader can be told a group
  // holds fewer members than it does. The array keeps the NEWEST members, which are the ones "keep
  // newest" reads and a reviewer needs.
  const capped =
    options.maxGroupMembers === undefined
      ? groups
      : groups.map(group => ({ ...group, members: group.members.slice(0, options.maxGroupMembers) }));

  return {
    scope: options.scope,
    totalMembers: members.length,
    armSplit,
    duplicateNameCount: capped.length,
    duplicateMemberCount,
    bucketCounts,
    duplicateGroups: options.maxGroups === undefined ? capped : capped.slice(0, options.maxGroups),
    scanTruncated: options.scanTruncated ?? false,
  };
}

/**
 * The membership report as it leaves the process.
 *
 * `serverTextHash`, `userId`, `relativePath` and `driveFileId` are facts the repair arm reasons over,
 * not client data. The hash in particular is a stable, global content identifier: emitting it hands
 * any lake reader a confirmation oracle ("this lake holds exactly the document I already hold") and
 * lets one document be correlated across lakes under different names, neither of which the fabFileId
 * and fileName enumeration already on the wire provides. What a client needs from a hash comparison
 * is the derived `bucket`, which is already here. The two identity signals leak the uploader's own
 * folder tree and their Drive addressing; what a client needs from them is the group's `tier`, which
 * is on the GROUP and survives this projection.
 *
 * Stripped at the boundary rather than never computed, because `summarizeLakeMembership` must keep
 * both fields for `lakeMembershipRepair` to gate on. See the read gate on GET
 * /api/data-lakes/:id/health: it admits `public`, so this payload's audience is wider than the lake's
 * owner.
 */
export type WireDuplicateGroupMember = Omit<
  DuplicateGroupMember,
  'serverTextHash' | 'userId' | 'relativePath' | 'driveFileId'
>;
export type WireDuplicateGroup = Omit<DuplicateGroup, 'members'> & { members: WireDuplicateGroupMember[] };
export type WireLakeMembershipReport = Omit<LakeMembershipReport, 'duplicateGroups'> & {
  duplicateGroups: WireDuplicateGroup[];
};

/**
 * One group's wire projection. Extracted so every door that ships a duplicate group - the health
 * report and the repair-plan read (#2238) - strips the same fields; a second hand-rolled projection
 * is how one of them starts disclosing `serverTextHash`.
 */
export function toWireDuplicateGroup(group: DuplicateGroup): WireDuplicateGroup {
  return {
    ...group,
    // An allowlist rather than a delete, so a field added to DuplicateGroupMember later stays OFF
    // the wire until someone names it here. Adding one without deciding is a type error, not a
    // silent disclosure.
    members: group.members.map(m => ({
      fabFileId: m.fabFileId,
      fileSize: m.fileSize,
      createdAt: m.createdAt,
      arm: m.arm,
    })),
  };
}

export function toWireMembershipReport(report: LakeMembershipReport): WireLakeMembershipReport {
  return {
    ...report,
    duplicateGroups: report.duplicateGroups.map(toWireDuplicateGroup),
  };
}
