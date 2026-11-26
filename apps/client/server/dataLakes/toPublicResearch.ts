import { dataLakeResearchService } from '@bike4mind/services';
import {
  upgradeLegacyResearchLevers,
  withResearchFeedStatus,
  type ConfigHistoryResponse,
  type IDataLakeProposalDocument,
  type IDataLakeResearchConfigDocument,
  type IDataLakeResearchRunDocument,
  type LakeConfigHistoryEntry,
  type LakeConfigHistoryFieldChange,
  type LakeConfigHistoryView,
  type LakeConfigUndoResult,
  type ProposalResource,
  type ResearchConfigResource,
  type ResearchLeversResource,
  type ResearchRunResource,
  type ResearchRunTotalsResource,
  type UndoConfigChangeResponse,
} from '@bike4mind/common';

/*
 * The only output guard on the public research routes: `nextRouteForContract` logs a response that
 * breaks its schema but still sends it, so nothing reaches the wire except through these mappers.
 * Every field is named. A spread would publish whatever the stored document grows next, including
 * internal user ids.
 */

type DateLike = Date | string | null | undefined;

const iso = (value: DateLike): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// -- Run failure text --------------------------------------------------------------------------

/*
 * A run's stored `error` is whatever the producer wrote: sometimes a fixed sentence, sometimes a
 * provider message that can echo a request. The public text is chosen by the producer's prefix and
 * never copied. These prefixes mirror apps/workers/src/dataLakes/runLakeResearch.ts,
 * packages/server-utils/src/dataLakes/queueResearchRun.ts and the feed errors in
 * b4m-core/services/src/dataLakeResearchService/executeResearchRun.ts. apps/client cannot import
 * apps/workers, so toPublicResearch.test.ts checks the worker source still contains each one.
 */
export const RESEARCH_ERROR_PREFIXES = {
  lakeMissing: 'The data lake this run targets no longer exists',
  ownerCannotRun: "This data lake's owner account cannot run research",
  searchNotConfigured: 'Web search is not configured.',
  queueFailed: 'The run could not be queued for execution.',
  judge: 'The relevance judge (',
  spendFrozen: 'Spending is paused',
  feed: [
    'This research config has no feed address',
    'Reading feeds is not available in this deployment',
    'This feed is larger than',
    'The feed could not be downloaded.',
    'This address is not an RSS or Atom feed',
  ],
} as const;

const FAILURE_TEXT = {
  lakeMissing: 'The data lake this run targeted no longer exists.',
  ownerCannotRun: "The lake owner's account cannot run research.",
  searchNotConfigured: 'Web search is not configured on this deployment.',
  queueFailed: 'The run could not be queued for execution. Try again shortly.',
  judge: 'The relevance judge failed, so nothing was proposed. Try the run again, or choose a different judge model.',
  spendFrozen: 'Spending is paused for the lake owner, so the run did not start.',
  feed: 'The feed could not be read. Check the feed address and that the site is reachable.',
  unexpected: 'The research run failed unexpectedly. Try again shortly.',
} as const;

const JUDGE_WARNING_TEXT = 'The relevance judge failed on some candidates, so they were not scored.';

export function classifyFailureReason(error: string | null | undefined): string {
  const text = error ?? '';
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.lakeMissing)) return FAILURE_TEXT.lakeMissing;
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.ownerCannotRun)) return FAILURE_TEXT.ownerCannotRun;
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.searchNotConfigured)) return FAILURE_TEXT.searchNotConfigured;
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.queueFailed)) return FAILURE_TEXT.queueFailed;
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.judge)) return FAILURE_TEXT.judge;
  if (text.startsWith(RESEARCH_ERROR_PREFIXES.spendFrozen)) return FAILURE_TEXT.spendFrozen;
  if (RESEARCH_ERROR_PREFIXES.feed.some(prefix => text.startsWith(prefix))) return FAILURE_TEXT.feed;
  return FAILURE_TEXT.unexpected;
}

// -- Configs -----------------------------------------------------------------------------------

type LeverSource = Parameters<typeof upgradeLegacyResearchLevers>[0];

function toPublicLevers(levers: LeverSource): ResearchLeversResource {
  const upgraded = upgradeLegacyResearchLevers(levers);
  return {
    source: upgraded.source,
    feed_url: upgraded.feedUrl,
    query: upgraded.query,
    model: upgraded.model ?? null,
    max_results: upgraded.maxResults,
    max_proposals: upgraded.maxProposals,
    recency_days: upgraded.recencyDays ?? null,
    trusted_domains: upgraded.trustedDomains,
    review_domains: upgraded.reviewDomains,
    unlisted_sources: upgraded.unlistedSources,
    auto_admit_trusted: upgraded.autoAdmitTrusted,
    max_auto_admits: upgraded.maxAutoAdmits,
    blocked_domains: upgraded.blockedDomains,
    min_relevance: upgraded.minRelevance,
    cost_ceiling_micro_usd: upgraded.costCeilingMicroUsd,
    proposed_tags: upgraded.proposedTags,
    item_rules: upgraded.itemRules.map(rule => ({ condition: rule.condition, action: rule.action })),
  };
}

function toPublicOutcome(config: IDataLakeResearchConfigDocument): ResearchConfigResource['last_scheduled_outcome'] {
  const outcome = config.lastScheduledOutcome;
  if (!outcome) return null;
  const base = {
    outcome: outcome.outcome,
    at: iso(outcome.at) ?? '',
    run_id: null,
    reason: null,
    pending_proposals: null,
    review_backlog_limit: null,
    error: null,
  };
  if (outcome.outcome === 'started') return { ...base, run_id: outcome.runId };
  if (outcome.outcome === 'skipped') {
    // A pause that was lifted since reads as a live skip reason on a schedule that is running again.
    if (outcome.reason === 'schedule_paused' && !config.schedulePaused) return null;
    return {
      ...base,
      reason: outcome.reason,
      pending_proposals: outcome.pendingProposals ?? null,
      review_backlog_limit: outcome.reviewBacklogLimit ?? null,
    };
  }
  return { ...base, error: dataLakeResearchService.SCHEDULED_START_FAILED_MESSAGE };
}

/**
 * `pendingProposals` is the lake's live count. `held` agrees with the scheduler and the panel: a
 * config is held only while its schedule is active and the backlog is at or over its limit.
 */
export function toPublicConfig(
  config: IDataLakeResearchConfigDocument,
  pendingProposals: number
): ResearchConfigResource {
  const withStatus = withResearchFeedStatus(config, dataLakeResearchService.feedFingerprintLevers(config));
  const feedStatus = withStatus.feedStatus;
  const paused = config.schedulePaused === true;
  return {
    ...toPublicLevers(config),
    id: config.id,
    lake_id: config.dataLakeId,
    name: config.name,
    trigger: config.trigger,
    cadence: config.cadence,
    review_backlog_limit: config.reviewBacklogLimit,
    schedule_paused: paused,
    held: config.cadence !== 'off' && !paused && pendingProposals >= config.reviewBacklogLimit,
    next_run_at: iso(config.nextRunAt),
    last_run_at: iso(config.lastRunAt),
    last_scheduled_outcome: toPublicOutcome(config),
    feed_status: feedStatus
      ? { newest_published_at: iso(feedStatus.newestPublishedAt), current: feedStatus.current }
      : null,
    created_at: iso(config.createdAt),
    updated_at: iso(config.updatedAt),
  };
}

// -- Runs --------------------------------------------------------------------------------------

function toPublicTotals(totals: IDataLakeResearchRunDocument['totals']): ResearchRunTotalsResource {
  return {
    search_hits: totals.searchHits ?? 0,
    filtered_by_source: totals.filteredBySource ?? 0,
    // Null, not 0: a run stored before the split has no value, and its filtered_by_source is combined.
    unlisted_dropped: totals.unlistedDropped ?? null,
    unresolved_redirect: totals.unresolvedRedirect ?? 0,
    below_relevance: totals.belowRelevance ?? 0,
    judge_failed: totals.judgeFailed ?? 0,
    fetch_failed: totals.fetchFailed ?? 0,
    proposed: totals.proposed ?? 0,
    auto_admitted: totals.autoAdmitted ?? 0,
    auto_admit_skipped: totals.autoAdmitSkipped ?? 0,
    duplicate_pending: totals.duplicatePending ?? 0,
    already_in_lake: totals.alreadyInLake ?? 0,
    suppressed_by_tombstone: totals.suppressedByTombstone ?? 0,
    unusable_source: totals.unusableSource ?? 0,
    not_judged: totals.notJudged ?? 0,
    blocked_by_rule: totals.blockedByRule ?? 0,
    reviewed_by_rule: totals.reviewedByRule ?? 0,
  };
}

export function toPublicRun(run: IDataLakeResearchRunDocument): ResearchRunResource {
  return {
    id: run.id,
    lake_id: run.dataLakeId,
    config_id: run.configId,
    trigger: run.trigger,
    status: run.status,
    started_at: iso(run.startedAt),
    completed_at: iso(run.completedAt),
    created_at: iso(run.createdAt),
    stop_reason: run.stopReason ?? null,
    spent_micro_usd: run.spentMicroUsd,
    levers: toPublicLevers(run.levers),
    totals: toPublicTotals(run.totals),
    feed_backlog: run.feedBacklog ?? null,
    judge_model: run.judgeModel ?? null,
    failure_reason: run.status === 'failed' ? classifyFailureReason(run.error) : null,
    judge_warning:
      run.status === 'completed' && run.error?.startsWith(RESEARCH_ERROR_PREFIXES.judge) ? JUDGE_WARNING_TEXT : null,
  };
}

// -- Proposals ---------------------------------------------------------------------------------

export function toPublicProposal(proposal: IDataLakeProposalDocument): ProposalResource {
  const provenance = proposal.provenance;
  return {
    id: proposal.id,
    lake_id: proposal.dataLakeId,
    status: proposal.status,
    source_url: proposal.sourceUrl,
    title: proposal.title,
    excerpt: proposal.excerpt ?? null,
    proposed_tags: proposal.proposedTags,
    confidence: proposal.confidence ?? null,
    rationale: proposal.rationale ?? null,
    provenance: {
      producer: provenance.producer,
      run_id: provenance.runId ?? null,
      query: provenance.query ?? null,
      feed_url: provenance.feedUrl ?? null,
      retrieved_at: iso(provenance.retrievedAt) ?? '',
      source_tier: provenance.sourceTier ?? null,
      review_reason: provenance.reviewReason
        ? { kind: provenance.reviewReason.kind, conditions: provenance.reviewReason.conditions ?? [] }
        : null,
    },
    prior_disposition: proposal.priorDisposition ?? null,
    reviewed_at: iso(proposal.reviewedAt),
    auto_admission: proposal.autoAdmission
      ? { config_id: proposal.autoAdmission.configId, trusted_domain: proposal.autoAdmission.trustedDomain ?? null }
      : null,
    decline_reason: proposal.declineReason ?? null,
    admitted_file_id: proposal.admittedFabFileId ?? null,
    created_at: iso(proposal.createdAt),
    updated_at: iso(proposal.updatedAt),
  };
}

// -- Config history ----------------------------------------------------------------------------

const IDENTITY_FIELDS = new Set(['effectiveOwnerUserId', 'createdByUserId']);
const USER_GRANT_ID = /user:[0-9a-f]{24}/gi;
const UNKNOWN_USER = 'unknown user';

type PublicChange = Extract<ConfigHistoryResponse['data']['entries'][number], { kind: 'config' }>['changes'][number];

/*
 * The history stores user ids as values (the owner a lake moved to) and inside access-grant text
 * (`user:<id>=role`). The SPA resolves them client side from `userNames`. Here they are replaced by
 * display names on the server, so no user id is on the wire.
 */
function toPublicChange(change: LakeConfigHistoryFieldChange, userNames: Record<string, string>): PublicChange {
  if (change.kind === 'fingerprint') {
    return {
      field: change.field,
      kind: 'fingerprint',
      before_fingerprint: { present: change.beforeFingerprint.present, length: change.beforeFingerprint.length },
      after_fingerprint: { present: change.afterFingerprint.present, length: change.afterFingerprint.length },
      text_unchanged: change.textUnchanged,
    };
  }
  const redact = (value: string | number | boolean | null | undefined) => {
    if (typeof value !== 'string') return value;
    if (IDENTITY_FIELDS.has(change.field)) {
      // An ownership change can carry several prior owners as comma-joined ids.
      return value
        .split(',')
        .map(id => userNames[id] ?? UNKNOWN_USER)
        .join(', ');
    }
    if (change.field === 'accessGrant') {
      return value.replace(USER_GRANT_ID, match => `user:${userNames[match.slice(5)] ?? UNKNOWN_USER}`);
    }
    return value;
  };
  const out: PublicChange = { field: change.field, kind: 'literal' };
  if ('before' in change) out.before = redact(change.before);
  if ('after' in change) out.after = redact(change.after);
  if (change.truncated) out.truncated = true;
  return out;
}

type PublicEntry = ConfigHistoryResponse['data']['entries'][number];

function toPublicEntry(entry: LakeConfigHistoryEntry, userNames: Record<string, string>): PublicEntry {
  const base = {
    event_id: entry.eventId,
    changed_at: iso(entry.changedAt) ?? '',
    principal_kind: entry.principalKind,
    principal_name: entry.principalName ?? null,
    undoable: entry.undoable === true,
    undone_by_event_id: entry.undoneByEventId ?? null,
  };
  if (entry.kind === 'file') {
    return {
      kind: 'file',
      ...base,
      target: { kind: entry.target.kind, id: entry.target.id },
      file_name: entry.fileName ?? null,
      action: entry.action,
      origin: entry.origin,
      ...(entry.undoesEventId ? { undoes_event_id: entry.undoesEventId } : {}),
      ...(entry.causedByEventId ? { caused_by_event_id: entry.causedByEventId } : {}),
    };
  }
  return {
    kind: 'config',
    ...base,
    ...(entry.target ? { target: { kind: entry.target.kind, id: entry.target.id } } : {}),
    manage_rung: entry.manageRung,
    action: entry.action,
    changes: entry.changes.map(change => toPublicChange(change, userNames)),
    ...(entry.leverChanges
      ? { lever_changes: entry.leverChanges.map(c => ({ lever: c.lever, before: c.before, after: c.after })) }
      : {}),
    ...(entry.admittedFabFileId ? { admitted_fab_file_id: entry.admittedFabFileId } : {}),
  };
}

export function toPublicUndoResult(result: LakeConfigUndoResult): UndoConfigChangeResponse {
  return { data: result.entry ? toPublicEntry(result.entry, {}) : null, notes: result.notes };
}

export function toPublicConfigHistory(view: LakeConfigHistoryView): ConfigHistoryResponse {
  return {
    data: {
      lake_id: view.lakeId,
      lake_name: view.lakeName,
      entries: view.entries.map(entry => toPublicEntry(entry, view.userNames)),
      truncated: view.truncated,
      window_starts_at: iso(view.windowStartsAt),
      generated_at: iso(view.generatedAt) ?? '',
    },
  };
}
