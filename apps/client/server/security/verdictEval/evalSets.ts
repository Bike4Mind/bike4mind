import { randomBytes } from 'node:crypto';
import type { AbuseAssessmentResult, AutoContainmentOutcome, ShadowDetectionVerdict } from '@bike4mind/common';
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
import { cohortsOf } from './cohorts';
import {
  campaignKeys,
  gradeEvalSet,
  seededSample,
  splitOf,
  windowCovering,
  type EvalSetPredictions,
} from './evalSetMath';
import {
  labelAccountsAndDetections,
  type EvalAssessment,
  type EvalDetection,
  type SignupChartVerdict,
} from './gradeVerdicts';
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
};

export const liveEvalSetDeps: EvalSetDeps = {
  ...liveVerdictEvalDeps,
  newSeed: () => randomBytes(16).toString('hex'),
};

type LeanDetection = {
  _id: { toString(): string };
  detector: string;
  policyVersion: number;
  userIds: string[];
  group?: { members?: { userId: string }[] } | null;
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
};
type LeanIpUser = { _id: { toString(): string }; signupMeta?: { ip?: string | null } | null };

const toObjectIds = (ids: readonly string[]) => ids.map(id => new mongoose.Types.ObjectId(id));

/**
 * Detections in the window. A detection flags only its own userIds; `linkGroups` adds its campaign
 * members, which link accounts into one campaign without flagging them.
 */
async function loadWindowDetections(since: Date) {
  const rows = await ShadowDetectionModel.find(
    { detectedAt: { $gte: since } },
    { detector: 1, policyVersion: 1, userIds: 1, 'group.members.userId': 1, detectedAt: 1, verdict: 1 }
  )
    .sort({ detectedAt: -1 })
    .limit(VERDICT_EVAL_DETECTION_LIMIT + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDetection[]>()
    .exec();
  const kept = rows.slice(0, VERDICT_EVAL_DETECTION_LIMIT);
  const detections: EvalDetection[] = kept.map(row => ({
    id: row._id.toString(),
    detector: row.detector,
    policyVersion: row.policyVersion,
    userIds: [...new Set(row.userIds)].filter(id => OBJECT_ID.test(id)),
    detectedAt: row.detectedAt,
    verdict: row.verdict ?? null,
  }));
  const linkGroups = kept.map(row =>
    [...new Set([...row.userIds, ...(row.group?.members ?? []).map(member => member.userId)])].filter(id =>
      OBJECT_ID.test(id)
    )
  );
  return { detections, linkGroups, truncated: rows.length > VERDICT_EVAL_DETECTION_LIMIT };
}

/** Accounts that share a signup IP with another account in `userIds`, as groups. */
async function sharedSignupIpGroups(userIds: string[]): Promise<string[][]> {
  const users = await inChunks(userIds, chunk =>
    User.find({ _id: { $in: toObjectIds(chunk) } }, { 'signupMeta.ip': 1 })
      .maxTimeMS(MAX_TIME_MS)
      .lean<LeanIpUser[]>()
      .exec()
  );
  const byIp = new Map<string, string[]>();
  for (const user of users) {
    const ip = user.signupMeta?.ip;
    if (ip) byIp.set(ip, [...(byIp.get(ip) ?? []), user._id.toString()]);
  }
  return [...byIp.values()].filter(group => group.length > 1);
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

  const { detections, linkGroups, truncated: detectionsTruncated } = await loadWindowDetections(window.since);
  const flaggedAll = [...new Set(detections.flatMap(detection => detection.userIds))].sort();
  const flagged =
    flaggedAll.length > EVAL_SET_FLAGGED_LIMIT ? seededSample(flaggedAll, seed, EVAL_SET_FLAGGED_LIMIT) : flaggedAll;

  const [createdInWindow, flaggedInWindow] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: window.since, $lte: window.until } })
      .maxTimeMS(MAX_TIME_MS)
      .exec(),
    countCreatedInWindow(flaggedAll, window),
  ]);
  const unflagged = await sampleUnflagged(window, new Set(flaggedAll), flaggedInWindow, request.unflaggedSample);

  const members = [...flagged, ...unflagged];
  const [{ accounts, signedUpAt }, signals, ipGroups] = await Promise.all([
    loadAccountOutcomes(members, deps, now, request.days, { skipSignupVerdicts: true }),
    loadCohortSignals(members),
    sharedSignupIpGroups(members),
  ]);
  const { signupLabels } = labelAccountsAndDetections(detections, accounts);
  const keys = campaignKeys(seed, members, [...linkGroups, ...ipGroups]);

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
    population: { flagged: flaggedAll.length, unflagged: Math.max(0, createdInWindow - flaggedInWindow) },
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
        { detectionId: 1, result: 1, confidence: 1, decisionModel: 1, assessedAt: 1 }
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
  // The chart verdict is only computed for a report window; a set older than 90 days gets none, so
  // its examples abstain on that grader.
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
    assessments: assessments.map<EvalAssessment>(row => ({
      detectionId: row.detectionId,
      result: row.result,
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
