import {
  canonicalItemRules,
  feedLabel,
  researchItemRuleKey,
  type ILakeConfigLeverChange,
  type ILakeConfigLiteralChange,
  type IDataLakeResearchConfigDocument,
  type ResearchItemRule,
  type ResearchRunLevers,
  type ResearchScheduleCadence,
} from '@bike4mind/common';
import {
  researchAutoAdmitChange,
  researchItemRulesChange,
  researchLeverChange,
  researchReviewBacklogLimitChange,
  researchScheduleCadenceChange,
  researchSchedulePausedChange,
  researchSourceChange,
  researchTrustedSitesChange,
} from '../dataLakeService/diffLakeConfig';
import { normalizeReviewBacklogLimit } from './researchSchedule';

const sameValue = <T extends string | number | boolean>(a: T, b: T) => a === b;
// `recencyDays`/`model` are coerced to `null` on both sides, matching how each is stored on update.
const sameNullable = <T>(a: T | undefined, b: T | undefined) => (a ?? null) === (b ?? null);
// Set semantics: a reordered resubmit of the same domains/tags is not an edit.
const sameStringSet = (a: readonly string[], b: readonly string[]) => {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every(value => setB.has(value));
};

// Derived from ResearchRunLevers so a new lever without a comparer is a compile error, not a
// silently-ignored edit that records no History event.
export const LEVER_EQUALITY: {
  [K in keyof ResearchRunLevers]-?: (a: ResearchRunLevers[K], b: ResearchRunLevers[K]) => boolean;
} = {
  // A config document read without the lever (not through the upgrader) is a search config.
  source: (a, b) => (a ?? 'search') === (b ?? 'search'),
  feedUrl: sameNullable,
  query: sameValue,
  model: sameNullable,
  maxResults: sameValue,
  maxProposals: sameValue,
  recencyDays: sameNullable,
  trustedDomains: sameStringSet,
  reviewDomains: sameStringSet,
  unlistedSources: sameValue,
  autoAdmitTrusted: sameValue,
  maxAutoAdmits: sameValue,
  // Derived from the three fields above, so it can never be the reason a config moved.
  allowedDomains: () => true,
  blockedDomains: sameStringSet,
  minRelevance: sameValue,
  costCeilingMicroUsd: sameValue,
  proposedTags: sameStringSet,
  itemRules: (a, b) =>
    sameStringSet(canonicalItemRules(a).map(researchItemRuleKey), canonicalItemRules(b).map(researchItemRuleKey)),
};

type LeverKey = keyof ResearchRunLevers;
const LEVER_KEYS = Object.keys(LEVER_EQUALITY) as LeverKey[];

export const leversDiffer = (next: ResearchRunLevers, current: ResearchRunLevers): boolean =>
  LEVER_KEYS.some(
    // The union of per-key comparers cannot be called with a union key; each pair is type-matched by the map above.
    key => !(LEVER_EQUALITY[key] as (a: unknown, b: unknown) => boolean)(next[key], current[key])
  );

/** Everything a History row says about a config: the levers plus the schedule settings beside them. */
export interface ResearchConfigState {
  name: string;
  levers: ResearchRunLevers;
  cadence: ResearchScheduleCadence;
  reviewBacklogLimit: number;
  schedulePaused: boolean;
}

export const researchConfigStateOf = (config: IDataLakeResearchConfigDocument): ResearchConfigState => ({
  name: config.name,
  levers: { ...config, autoAdmitTrusted: config.autoAdmitTrusted === true },
  cadence: config.cadence ?? 'off',
  reviewBacklogLimit: normalizeReviewBacklogLimit(config.reviewBacklogLimit),
  schedulePaused: config.schedulePaused === true,
});

const snake = (key: string) => key.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`);
const show = (value: unknown) => (value === null || value === undefined ? 'none' : String(value));

const scalarLine =
  (key: LeverKey) =>
  (before: unknown, after: unknown, name: string): ILakeConfigLiteralChange =>
    researchLeverChange(name, `${snake(key)} ${show(before)} -> ${show(after)}`);

/** Counts only, so a long list reads as "3 sites added, 1 removed". */
const listLine =
  (key: LeverKey, noun: string) =>
  (before: readonly string[], after: readonly string[], name: string): ILakeConfigLiteralChange => {
    const added = after.filter(entry => !before.includes(entry)).length;
    const removed = before.filter(entry => !after.includes(entry)).length;
    const plural = (n: number) => `${noun}${n === 1 ? '' : 's'}`;
    const parts = [
      ...(added > 0 ? [`${added} ${plural(added)} added`] : []),
      ...(removed > 0 ? [`${added > 0 ? removed : `${removed} ${plural(removed)}`} removed`] : []),
    ];
    return researchLeverChange(name, `${snake(key)} ${parts.join(', ')}`);
  };

const itemRuleCounts = (
  before: readonly ResearchItemRule[] | undefined,
  after: readonly ResearchItemRule[] | undefined
) => {
  const beforeKeys = new Set(canonicalItemRules(before).map(researchItemRuleKey));
  const afterKeys = new Set(canonicalItemRules(after).map(researchItemRuleKey));
  return {
    added: [...afterKeys].filter(key => !beforeKeys.has(key)).length,
    removed: [...beforeKeys].filter(key => !afterKeys.has(key)).length,
  };
};

/** The item-rule count line, or no line when the rule set did not move. */
export const itemRuleChanges = (
  name: string,
  before: readonly ResearchItemRule[] | undefined,
  after: readonly ResearchItemRule[] | undefined
): ILakeConfigLiteralChange[] => {
  const { added, removed } = itemRuleCounts(before, after);
  return added > 0 || removed > 0 ? [researchItemRulesChange(name, added, removed)] : [];
};

type LeverLine = {
  [K in LeverKey]-?: (
    before: ResearchRunLevers[K],
    after: ResearchRunLevers[K],
    name: string,
    next: ResearchRunLevers
  ) => ILakeConfigLiteralChange | null;
};

// One phrasing per lever, total over ResearchRunLevers: a new lever without one fails to compile.
const LEVER_LINE: LeverLine = {
  // Source and feed address share one line, built from the new state; the diff drops the duplicate.
  source: (_b, _a, name, next) => researchSourceChange(name, next.source, next.feedUrl),
  feedUrl: (_b, _a, name, next) => researchSourceChange(name, next.source, next.feedUrl),
  query: (_b, _a, name) => researchLeverChange(name, 'query changed'),
  model: scalarLine('model'),
  maxResults: scalarLine('maxResults'),
  maxProposals: scalarLine('maxProposals'),
  recencyDays: scalarLine('recencyDays'),
  trustedDomains: (before, after, name) =>
    researchTrustedSitesChange(
      name,
      after.filter(entry => !before.includes(entry)),
      before.filter(entry => !after.includes(entry))
    ),
  reviewDomains: listLine('reviewDomains', 'site'),
  unlistedSources: scalarLine('unlistedSources'),
  autoAdmitTrusted: (_b, after, name) => researchAutoAdmitChange(name, after),
  maxAutoAdmits: scalarLine('maxAutoAdmits'),
  allowedDomains: () => null,
  blockedDomains: listLine('blockedDomains', 'site'),
  minRelevance: scalarLine('minRelevance'),
  costCeilingMicroUsd: scalarLine('costCeilingMicroUsd'),
  proposedTags: listLine('proposedTags', 'tag'),
  itemRules: (before, after, name) => {
    const { added, removed } = itemRuleCounts(before, after);
    return researchItemRulesChange(name, added, removed);
  },
};

// Lines for these levers keep the order History has always shown them in.
const LINE_ORDER: LeverKey[] = [
  'autoAdmitTrusted',
  'trustedDomains',
  'itemRules',
  'source',
  'feedUrl',
  ...LEVER_KEYS.filter(key => !['autoAdmitTrusted', 'trustedDomains', 'itemRules', 'source', 'feedUrl'].includes(key)),
];

/** The value a lever carries in a History row. A feed address is redacted here and nowhere else. */
const leverValue = (key: LeverKey, levers: ResearchRunLevers): unknown => {
  if (key === 'feedUrl') return levers.feedUrl ? feedLabel(levers.feedUrl) : null;
  if (key === 'itemRules') return canonicalItemRules(levers.itemRules);
  return levers[key] ?? null;
};

export interface ResearchConfigDiff {
  /** Pause, cadence and backlog-limit lines. Recorded even when no lever moved. */
  scheduleLines: ILakeConfigLiteralChange[];
  /** One line per moved lever (and the name), in History's long-standing order. */
  leverLines: ILakeConfigLiteralChange[];
  leverChanges: ILakeConfigLeverChange[];
}

export function diffResearchConfig(before: ResearchConfigState, after: ResearchConfigState): ResearchConfigDiff {
  const name = after.name;
  const scheduleLines: ILakeConfigLiteralChange[] = [];
  const leverLines: ILakeConfigLiteralChange[] = [];
  const leverChanges: ILakeConfigLeverChange[] = [];

  if (before.name !== after.name) {
    leverChanges.push({ lever: 'name', before: before.name, after: after.name });
    leverLines.push(researchLeverChange(name, `name ${before.name} -> ${after.name}`));
  }
  if (before.schedulePaused !== after.schedulePaused) {
    leverChanges.push({ lever: 'schedulePaused', before: before.schedulePaused, after: after.schedulePaused });
    // Setting the cadence off clears the flag, but that is the schedule going off, not a resume.
    if (after.cadence !== 'off') scheduleLines.push(researchSchedulePausedChange(name, after.schedulePaused));
  }
  if (before.cadence !== after.cadence) {
    leverChanges.push({ lever: 'cadence', before: before.cadence, after: after.cadence });
    scheduleLines.push(researchScheduleCadenceChange(name, before.cadence, after.cadence));
  }
  if (before.reviewBacklogLimit !== after.reviewBacklogLimit) {
    leverChanges.push({
      lever: 'reviewBacklogLimit',
      before: before.reviewBacklogLimit,
      after: after.reviewBacklogLimit,
    });
    scheduleLines.push(researchReviewBacklogLimitChange(name, before.reviewBacklogLimit, after.reviewBacklogLimit));
  }

  const seen = new Set<string>();
  for (const key of LINE_ORDER) {
    if ((LEVER_EQUALITY[key] as (a: unknown, b: unknown) => boolean)(after.levers[key], before.levers[key])) continue;
    leverChanges.push({ lever: key, before: leverValue(key, before.levers), after: leverValue(key, after.levers) });
    const line = (
      LEVER_LINE[key] as (b: unknown, a: unknown, n: string, l: ResearchRunLevers) => ILakeConfigLiteralChange | null
    )(before.levers[key], after.levers[key], name, after.levers);
    if (line && line.after !== undefined && !seen.has(String(line.after))) {
      seen.add(String(line.after));
      leverLines.push(line);
    }
  }
  return { scheduleLines, leverLines, leverChanges };
}

/** Every lever and schedule setting of a deleted config, `after: null`, feed address redacted. */
export function snapshotLeverChanges(state: ResearchConfigState): ILakeConfigLeverChange[] {
  return [
    { lever: 'name', before: state.name, after: null },
    { lever: 'cadence', before: state.cadence, after: null },
    { lever: 'reviewBacklogLimit', before: state.reviewBacklogLimit, after: null },
    { lever: 'schedulePaused', before: state.schedulePaused, after: null },
    ...LEVER_KEYS.filter(key => key !== 'allowedDomains').map(key => ({
      lever: key,
      before: leverValue(key, state.levers),
      after: null,
    })),
  ];
}
