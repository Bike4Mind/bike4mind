import { randomBytes } from 'node:crypto';
import type {
  AbuseAssessmentResult,
  AutoContainmentOutcome,
  ShadowDetectionVerdict,
  ShadowDetectionVerdictSource,
} from '@bike4mind/common';
import {
  AbuseAssessmentModel,
  AutoContainmentDecisionModel,
  ShadowDetectionModel,
  User,
  abuseEvalSetRepository,
  mongoose,
  type AbuseEvalExample,
  type AbuseEvalRun,
  type AbuseEvalSetItem,
} from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  evalSetRunSchema,
  type EvalSetCreateRequest,
  type EvalSetRun,
  type EvalSetRunResponse,
} from '@client/app/utils/verdictEvalSets';
import { abuseProbabilityOf, type CalibratedAssessment } from './calibration';
import { cohortsOf } from './cohorts';
import {
  campaignKeys,
  gradeEvalSet,
  seededSample,
  sharedIpGroups,
  splitOf,
  windowCovering,
  type EvalSetPredictions,
} from './evalSetMath';
import { labelAccountsAndDetections, type EvalDetection, type SignupChartVerdict } from './gradeVerdicts';
import {
  VERDICT_EVAL_DETECTION_LIMIT,
  inChunks,
  liveVerdictEvalDeps,
  loadAccountOutcomes,
  loadCohortSignals,
  type VerdictEvalDeps,
} from './loadVerdictEval';

/**
 * Draws, stores and grades frozen abuse evaluation sets. Shadow mode: the only collection written is
 * AbuseEvalSet; users, credits and review states are only read. Pure parts are in evalSetMath.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIME_MS = 20_000;
export const EVAL_SET_FLAGGED_LIMIT = 500;
/** Most accounts one `$sample` draws for the unflagged examples, before flagged ones are dropped. */
export const EVAL_SET_SAMPLE_DRAW_LIMIT = 5_000;
const OBJECT_ID = /^[0-9a-f]{24}$/;

export type EvalSetDeps = VerdictEvalDeps & {
  /** A fresh seed per draw; injectable so tests can fix the sample. */
  newSeed: () => string;
  /** Newest in-window detections a draw reads; injectable so tests can exceed it with a few rows. */
  detectionLimit: number;
};

export const liveEvalSetDeps: EvalSetDeps = {
  ...liveVerdictEvalDeps,
  newSeed: () => randomBytes(16).toString('hex'),
  detectionLimit: VERDICT_EVAL_DETECTION_LIMIT,
};

type LeanDetection = {
  _id: { toString(): string };
  detector: string;
  policyVersion: number;
  userIds: string[];
  group?: { members?: { userId: string }[] } | null;
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
  verdicts?: { source?: ShadowDetectionVerdictSource }[];
};
type LeanLinkDetection = Pick<LeanDetection, 'userIds' | 'group'>;
type LeanIpUser = { _id: { toString(): string }; signupMeta?: { ip?: string | null } | null };

const toObjectIds = (ids: readonly string[]) => ids.map(id => new mongoose.Types.ObjectId(id));

/** Everyone a detection names: its userIds and its campaign members. */
const linkGroupOf = (row: LeanLinkDetection): string[] =>
  [...new Set([...row.userIds, ...(row.group?.members ?? []).map(member => member.userId)])].filter(id =>
    OBJECT_ID.test(id)
  );

/**
 * The newest `limit` detections in the window. A detection flags only its own userIds; `linkGroups`
 * adds its campaign members, which link accounts into one campaign without flagging them.
 */
async function loadWindowDetections(since: Date, limit: number) {
  const rows = await ShadowDetectionModel.find(
    { detectedAt: { $gte: since } },
    {
      detector: 1,
      policyVersion: 1,
      userIds: 1,
      'group.members.userId': 1,
      detectedAt: 1,
      verdict: 1,
      verdicts: { $slice: -1 },
    }
  )
    .sort({ detectedAt: -1 })
    .limit(limit + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDetection[]>()
    .exec();
  const kept = rows.slice(0, limit);
  const detections: EvalDetection[] = kept.map(row => ({
    id: row._id.toString(),
    detector: row.detector,
    policyVersion: row.policyVersion,
    userIds: [...new Set(row.userIds)].filter(id => OBJECT_ID.test(id)),
    detectedAt: row.detectedAt,
    verdict: row.verdict ?? null,
    verdicts: row.verdicts ?? [],
  }));
  return { detections, linkGroups: kept.map(linkGroupOf), truncated: rows.length > limit };
}

/**
 * Every account any in-window detection flags, uncapped, so an account flagged only past the
 * detection limit is still kept out of the unflagged sample.
 */
async function loadFlaggedInWindow(since: Date): Promise<string[]> {
  const ids: unknown[] = await ShadowDetectionModel.distinct('userIds', { detectedAt: { $gte: since } })
    .maxTimeMS(MAX_TIME_MS)
    .exec();
  return ids.filter((id): id is string => typeof id === 'string' && OBJECT_ID.test(id));
}

/** Every detection, at any time, naming one of `userIds`, as link groups; links only, never flags. */
async function loadMemberLinkGroups(userIds: string[]): Promise<string[][]> {
  const rows = await inChunks(userIds, chunk =>
    ShadowDetectionModel.find(
      { $or: [{ userIds: { $in: chunk } }, { 'group.members.userId': { $in: chunk } }] },
      { _id: 0, userIds: 1, 'group.members.userId': 1 }
    )
      .maxTimeMS(MAX_TIME_MS)
      .lean<LeanLinkDetection[]>()
      .exec()
  );
  return rows.map(linkGroupOf);
}

/** Accounts in `userIds` that share a signup IP, as groups (see sharedIpGroups for the cap). */
async function sharedSignupIpGroups(userIds: string[]): Promise<string[][]> {
  const users = await inChunks(userIds, chunk =>
    User.find({ _id: { $in: toObjectIds(chunk) } }, { 'signupMeta.ip': 1 })
      .maxTimeMS(MAX_TIME_MS)
      .lean<LeanIpUser[]>()
      .exec()
  );
  return sharedIpGroups(users.map(user => ({ userId: user._id.toString(), ip: user.signupMeta?.ip })));
}

/**
 * A random sample of up to `size` accounts created in the window that no detection flagged. `$sample`
 * is not reproducible; the drawn ids are frozen in the set instead.
 */
async function sampleUnflagged(
  window: { since: Date; until: Date },
  flagged: ReadonlySet<string>,
  flaggedInWindow: number,
  size: number
): Promise<string[]> {
  const rows = await User.aggregate<{ _id: { toString(): string } }>([
    { $match: { createdAt: { $gte: window.since, $lte: window.until } } },
    // Oversampled so dropping the flagged accounts still leaves `size`.
    { $sample: { size: Math.min(size * 2 + flaggedInWindow, EVAL_SET_SAMPLE_DRAW_LIMIT) } },
    { $project: { _id: 1 } },
  ])
    .option({ maxTimeMS: MAX_TIME_MS })
    .exec();
  const ids = [...new Set(rows.map(row => row._id.toString()))];
  return ids.filter(id => !flagged.has(id)).slice(0, size);
}

/** Flagged accounts created inside the window; they are part of the window's signups but not unflagged. */
async function countCreatedInWindow(userIds: string[], window: { since: Date; until: Date }): Promise<number> {
  const counts = await inChunks(userIds, async chunk => [
    await User.countDocuments({
      _id: { $in: toObjectIds(chunk) },
      createdAt: { $gte: window.since, $lte: window.until },
    })
      .maxTimeMS(MAX_TIME_MS)
      .exec(),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * Draws a set: every flagged account in the window (a seeded sample of them past the cap) plus a
 * random sample of accounts created in it that no detection flagged. Labels are frozen as they stand;
 * each campaign lands on one split.
 */
export async function drawEvalSet(
  request: EvalSetCreateRequest,
  adminId: string,
  deps: EvalSetDeps = liveEvalSetDeps,
  now = new Date()
): Promise<string> {
  const window = { since: new Date(now.getTime() - request.days * DAY_MS), until: now };
  const seed = deps.newSeed();

  const [{ detections, linkGroups, truncated: detectionsTruncated }, everyFlagged] = await Promise.all([
    loadWindowDetections(window.since, deps.detectionLimit),
    loadFlaggedInWindow(window.since),
  ]);
  // Examples come from the detections read; who is flagged at all comes from the uncapped list.
  const flaggedAll = [...new Set(detections.flatMap(detection => detection.userIds))].sort();
  const flagged =
    flaggedAll.length > EVAL_SET_FLAGGED_LIMIT ? seededSample(flaggedAll, seed, EVAL_SET_FLAGGED_LIMIT) : flaggedAll;

  const [createdInWindow, flaggedInWindow] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: window.since, $lte: window.until } })
      .maxTimeMS(MAX_TIME_MS)
      .exec(),
    countCreatedInWindow(everyFlagged, window),
  ]);
  const unflagged = await sampleUnflagged(window, new Set(everyFlagged), flaggedInWindow, request.unflaggedSample);

  const members = [...flagged, ...unflagged];
  const [{ accounts, signedUpAt }, signals, ipGroups, memberLinkGroups] = await Promise.all([
    loadAccountOutcomes(members, deps, now, request.days, { skipSignupVerdicts: true }),
    loadCohortSignals(members),
    sharedSignupIpGroups(members),
    loadMemberLinkGroups(members),
  ]);
  const { signupLabels } = labelAccountsAndDetections(detections, accounts);
  const keys = campaignKeys(seed, members, [...linkGroups, ...memberLinkGroups, ...ipGroups]);

  const detectionsOf = new Map<string, string[]>();
  for (const detection of detections) {
    for (const userId of detection.userIds)
      detectionsOf.set(userId, [...(detectionsOf.get(userId) ?? []), detection.id]);
  }
  const example = (userId: string, kind: AbuseEvalExample['kind']) => {
    const campaignKey = keys.get(userId);
    if (!campaignKey) throw new Error('An evaluation example has no campaign key');
    const accountSignals = signals.get(userId);
    return {
      userId,
      kind,
      detectionIds: kind === 'flagged' ? (detectionsOf.get(userId) ?? []) : [],
      campaignKey,
      split: splitOf(seed, campaignKey, request.heldOutShare),
      cohorts: accountSignals ? cohortsOf(accountSignals) : [],
      signedUpAt: signedUpAt.get(userId) ?? null,
      frozenLabel: signupLabels.get(userId) ?? null,
    };
  };

  return abuseEvalSetRepository.create({
    name: request.name,
    note: request.note ?? null,
    createdBy: adminId,
    window,
    seed,
    heldOutShare: request.heldOutShare,
    population: { flagged: everyFlagged.length, unflagged: Math.max(0, createdInWindow - flaggedInWindow) },
    truncated: detectionsTruncated || flaggedAll.length > EVAL_SET_FLAGGED_LIMIT,
    examples: [
      ...flagged.map(userId => example(userId, 'flagged')),
      ...unflagged.map(userId => example(userId, 'unflagged')),
    ],
  });
}

type LeanAssessment = {
  detectionId: string;
  result: AbuseAssessmentResult;
  probabilities?: { value: string; probability: number }[];
  confidence: number | null;
  decisionModel: string;
  assessedAt: Date;
};
type LeanDecision = {
  detectionId: string;
  outcome: AutoContainmentOutcome;
  mode: string;
  confidence: number;
  decidedAt: Date;
};

/** The current assessments, containment decisions and chart verdicts for a set's held-out examples. */
async function loadPredictions(set: AbuseEvalSetItem, deps: VerdictEvalDeps, now: Date): Promise<EvalSetPredictions> {
  const heldOut = set.examples.filter(example => example.split === 'heldOut');
  const detectionIds = [...new Set(heldOut.flatMap(example => example.detectionIds))];
  const [assessments, decisions] = await Promise.all([
    inChunks(detectionIds, chunk =>
      AbuseAssessmentModel.find(
        { detectionId: { $in: chunk } },
        { detectionId: 1, result: 1, probabilities: 1, confidence: 1, decisionModel: 1, assessedAt: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanAssessment[]>()
        .exec()
    ),
    inChunks(detectionIds, chunk =>
      AutoContainmentDecisionModel.find(
        { detectionId: { $in: chunk } },
        { detectionId: 1, outcome: 1, mode: 1, confidence: 1, decidedAt: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanDecision[]>()
        .exec()
    ),
  ]);
  // The chart verdict exists only for a report window, and loadAccountOutcomes asks it only for
  // accounts that signed up within `days` of now. With the drift tolerance, examples in the first
  // day of an aged set fall outside that and abstain; a set past 90 days plus the tolerance gets no
  // window, so all its examples abstain on that grader.
  const days = windowCovering(set.window.since, now);
  const { signupVerdicts } =
    days === null
      ? { signupVerdicts: new Map<string, SignupChartVerdict>() }
      : await loadAccountOutcomes(
          heldOut.map(example => example.userId),
          deps,
          now,
          days
        );
  return {
    assessments: assessments.map<CalibratedAssessment>(row => ({
      detectionId: row.detectionId,
      result: row.result,
      abuseProbability: abuseProbabilityOf(row.probabilities ?? []),
      confidence: row.confidence ?? null,
      model: row.decisionModel,
      assessedAt: row.assessedAt,
    })),
    decisions,
    signupVerdicts,
  };
}

const parseRun = (run: AbuseEvalRun): EvalSetRun | null => {
  const parsed = evalSetRunSchema.safeParse(run);
  return parsed.success ? parsed.data : null;
};

/** Grades the set's held-out examples as the automation stands now, stores the run, returns it with the one before. */
export async function runEvalSet(
  setId: string,
  adminId: string,
  note: string | null,
  deps: VerdictEvalDeps = liveVerdictEvalDeps,
  now = new Date()
): Promise<EvalSetRunResponse> {
  const set = await abuseEvalSetRepository.findById(setId);
  if (!set) throw new NotFoundError('Evaluation set not found');
  const report = gradeEvalSet(set, await loadPredictions(set, deps, now));
  const runs = await abuseEvalSetRepository.appendRun(setId, { ranAt: now, ranBy: adminId, note, report });
  if (!runs) throw new NotFoundError('Evaluation set not found');
  const run = parseRun(runs[runs.length - 1]);
  if (!run) throw new Error('A stored evaluation run did not match its schema');
  return { run, previous: runs.length > 1 ? parseRun(runs[0]) : null };
}
