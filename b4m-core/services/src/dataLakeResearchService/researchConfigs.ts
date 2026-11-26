import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  ResearchKeysetPage,
  ResearchRunLevers,
  ResearchRunTrigger,
  ResearchScheduleCadence,
} from '@bike4mind/common';
import {
  canonicalItemRules,
  deriveLegacyAllowedDomains,
  isSameDomainSet,
  normalizeDomainList,
  RESEARCH_CONFIG_NAME_MAX_CHARS,
  RESEARCH_FEED_URL_MAX_CHARS,
  RESEARCH_ITEM_RULE_CONDITION_MAX_CHARS,
  RESEARCH_ITEM_RULES_MAX,
  upgradeLegacyResearchLevers,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { isPublicSuffixEntry } from '@bike4mind/utils/registrableDomain';
import {
  researchAutoAdmitChange,
  researchConfigChange,
  researchSchedulePausedChange,
} from '../dataLakeService/diffLakeConfig';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from '../dataLakeService/recordLakeConfigChange';
import { recordLakeConfigSnapshot, type LakeConfigSnapshotAdapters } from '../dataLakeService/recordLakeConfigSnapshot';
import {
  diffResearchConfig,
  leversDiffer,
  researchConfigStateOf,
  snapshotLeverChanges,
  itemRuleChanges,
  LEVER_EQUALITY,
} from './researchConfigChanges';
import { normalizeResearchLevers, type ResearchLeversDraft } from './researchLevers';
import { firstResearchRunAt, nextResearchRunAfter, normalizeReviewBacklogLimit } from './researchSchedule';

/**
 * CRUD for the saved run configuration (#1682). Thin on purpose: the caller has already gated the
 * lake (read gate then manage gate, the same pair the proposal routes use), so what is left here is
 * normalization and the schedule, which is not a lever.
 */

export interface ResearchConfigAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakeResearchConfigs: Pick<
      IDataLakeResearchConfigRepository,
      'createConfig' | 'listByLake' | 'findByIdInLake' | 'updateConfig' | 'deleteConfig'
    >;
    // REQUIRED, not optional: every caller of these writes is one of the two research-config
    // routes, so leaving it optional would let a create/edit/delete go unaudited silently.
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    // REQUIRED like the event repository: without it a delete or feed edit would record no undo
    // snapshot and nothing would say so.
    lakeConfigSnapshots: LakeConfigSnapshotAdapters['db']['lakeConfigSnapshots'];
  };
  now?: () => Date;
  /** Links the History row this call writes to an Undo: the row it reverses, and its pre-minted id. */
  audit?: { undoesEventId?: string; eventId?: string };
}

/** The schedule half of a create or update request. */
export interface ResearchScheduleDraft {
  trigger?: ResearchRunTrigger;
  cadence?: ResearchScheduleCadence;
  reviewBacklogLimit?: number;
  schedulePaused?: boolean;
}

/** How many saved configs one lake may hold, so a config list stays a list a human reads. */
export const RESEARCH_CONFIGS_PER_LAKE_MAX = 20;

const normalizeName = (name: unknown): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new BadRequestError('A research configuration needs a name');
  return trimmed.slice(0, RESEARCH_CONFIG_NAME_MAX_CHARS);
};

const triggerFor = (cadence: ResearchScheduleCadence): ResearchRunTrigger =>
  cadence === 'off' ? 'on_demand' : 'periodic';

/**
 * The cadence is the schedule; `trigger` is derived from it. A caller may still send `trigger`, but
 * only one that agrees: a `periodic` config with no cadence, or a one-off `scheduled` run nothing
 * fires, would save a setting that silently does nothing - worse than a refusal.
 */
const resolveCadence = (
  { trigger, cadence }: ResearchScheduleDraft,
  current: ResearchScheduleCadence
): ResearchScheduleCadence => {
  if (trigger === 'scheduled') {
    throw new BadRequestError('One-off scheduled research runs are not supported; set a cadence instead', {
      field: 'cadence',
    });
  }
  const resolved = cadence ?? current;
  if (trigger && trigger !== triggerFor(resolved)) {
    throw new BadRequestError(
      resolved === 'off'
        ? 'A periodic research configuration needs a cadence'
        : 'An on-demand research configuration cannot have a cadence',
      { field: 'cadence' }
    );
  }
  return resolved;
};

const PAUSED_WITHOUT_CADENCE_MESSAGE = 'A research schedule needs a cadence before it can be paused';

/**
 * The flag after an edit. Setting cadence `off` clears it, and a request to pause an `off` config is
 * refused rather than saved as a flag nothing reads. Any other cadence change keeps it.
 */
const resolveSchedulePaused = (
  requested: boolean | undefined,
  cadence: ResearchScheduleCadence,
  current: boolean
): boolean => {
  if (requested === true && cadence === 'off')
    throw new BadRequestError(PAUSED_WITHOUT_CADENCE_MESSAGE, { field: 'schedulePaused' });
  return cadence === 'off' ? false : (requested ?? current);
};

/**
 * Where a resumed schedule next fires. A future `nextRunAt` is kept: it is the first slot, a pending
 * one-hour retry, or a lease the in-flight tick's outcome write replaces, and recomputing from the
 * anchor would skip a period or jump past the retry. A stale one lands on the next regular slot,
 * never on an immediate run.
 */
const resumedNextRunAt = (
  existing: IDataLakeResearchConfigDocument,
  cadence: Exclude<ResearchScheduleCadence, 'off'>,
  now: Date
): Date =>
  existing.nextRunAt && existing.nextRunAt > now
    ? existing.nextRunAt
    : nextResearchRunAfter(cadence, existing.scheduleAnchorAt ?? existing.nextRunAt ?? now, now);

/**
 * Drop with nothing listed would ignore every hit, which no one means. Refused here and not in the
 * normalizer, because the normalizer also runs at run start and must never throw on a stored config.
 */
const assertSourcesReachable = (levers: ResearchRunLevers): void => {
  if (levers.unlistedSources === 'drop' && levers.trustedDomains.length + levers.reviewDomains.length === 0) {
    throw new BadRequestError('List at least one site to review, or send other sites to review', {
      field: 'unlistedSources',
    });
  }
};

/**
 * Shape only: a feed config needs an absolute http(s) address that fits the cap and carries no
 * credentials. SSRF is enforced when the address is fetched. Runs on the raw draft because the
 * normalizer truncates an over-long address and nulls an empty one, which would hide the problem.
 */
const assertFeedSource = (draft: ResearchLeversDraft): void => {
  if ((draft.source as unknown) !== 'feed') return;
  const raw = typeof draft.feedUrl === 'string' ? draft.feedUrl.trim() : '';
  if (!raw) throw new BadRequestError('A feed source needs a feed address', { field: 'feedUrl' });
  if (raw.length > RESEARCH_FEED_URL_MAX_CHARS) {
    throw new BadRequestError(`The feed address is longer than ${RESEARCH_FEED_URL_MAX_CHARS} characters`, {
      field: 'feedUrl',
    });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError('The feed address is not a valid web address', { field: 'feedUrl' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestError('The feed address must start with http:// or https://', { field: 'feedUrl' });
  }
  if (url.username || url.password) {
    throw new BadRequestError('The feed address must not contain a username or password', {
      field: 'feedUrl',
    });
  }
};

/**
 * Limits on the raw draft, counted after cleaning (invisible characters stripped, whitespace collapsed), empty-drop and
 * dedupe so a duplicate alone is not an error. Refused rather than truncated (a cut condition means something else), and checked here
 * because the normalizer clamps, which would hide the problem.
 */
const assertItemRulesWithinLimits = (draft: ResearchLeversDraft): void => {
  const rules = canonicalItemRules(draft.itemRules);
  if (rules.length > RESEARCH_ITEM_RULES_MAX) {
    throw new BadRequestError(`A research configuration can have at most ${RESEARCH_ITEM_RULES_MAX} item rules`, {
      field: 'itemRules',
    });
  }
  if (rules.some(rule => rule.condition.length > RESEARCH_ITEM_RULE_CONDITION_MAX_CHARS)) {
    throw new BadRequestError(
      `An item rule condition can be at most ${RESEARCH_ITEM_RULE_CONDITION_MAX_CHARS} characters`,
      { field: 'itemRules' }
    );
  }
};

/**
 * An entry that is itself a public suffix (`com`, `github.io`) would let auto-admit trust every site
 * anyone can create under it. Checked on the merged levers so a toggle-only edit cannot enable a
 * stored list that already holds one.
 */
const assertAutoAdmitEntriesSafe = (levers: ResearchRunLevers): void => {
  if (!levers.autoAdmitTrusted) return;
  const unsafe = levers.trustedDomains.find(isPublicSuffixEntry);
  if (unsafe) {
    throw new BadRequestError(
      `"${unsafe}" covers every site under it, so it cannot be a trusted site while trusted results are added automatically. List a specific site instead.`,
      { field: 'trustedDomains' }
    );
  }
};

/** An input that names the tiers is the new shape; its legacy `allowedDomains`, if any, is ignored. */
const usesTierFields = (input: ResearchLeversDraft): boolean =>
  input.unlistedSources !== undefined || input.reviewDomains !== undefined || input.trustedDomains !== undefined;

const withoutAllowedDomains = ({ allowedDomains: _ignored, ...rest }: ResearchLeversDraft): ResearchLeversDraft => rest;

/**
 * Resolves an edit that still carries `allowedDomains` (an open old tab) against the stored config.
 * Resubmitting what the config already derives is a no-op, so a query-only edit cannot disturb the
 * review list. A different value is an edit of the site list, mapped onto the tier fields.
 */
const resolveLegacyAllowedInput = (input: ResearchLeversDraft, existing: ResearchRunLevers): ResearchLeversDraft => {
  if (input.allowedDomains === undefined) return input;
  const rest = withoutAllowedDomains(input);
  if (usesTierFields(input)) return rest;

  const incoming = normalizeDomainList(input.allowedDomains);
  if (isSameDomainSet(incoming, deriveLegacyAllowedDomains(existing))) return rest;
  const converted = upgradeLegacyResearchLevers({ ...existing, allowedDomains: incoming });
  return { ...rest, reviewDomains: converted.reviewDomains, unlistedSources: converted.unlistedSources };
};

export async function createResearchConfig(
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  input: { name: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, logger, now = () => new Date(), audit }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.listByLake(lake.id);
  if (existing.length >= RESEARCH_CONFIGS_PER_LAKE_MAX) {
    throw new BadRequestError(
      `This data lake already has the maximum of ${RESEARCH_CONFIGS_PER_LAKE_MAX} research configurations`
    );
  }

  const name = normalizeName(input.name);
  const cadence = resolveCadence(input, 'off');
  const firstRunAt = firstResearchRunAt(cadence, now());
  const schedulePaused = resolveSchedulePaused(input.schedulePaused, cadence, false);
  assertFeedSource(input);
  assertItemRulesWithinLimits(input);
  const levers = normalizeResearchLevers(usesTierFields(input) ? withoutAllowedDomains(input) : input);
  assertSourcesReachable(levers);
  assertAutoAdmitEntriesSafe(levers);
  const created = await db.dataLakeResearchConfigs.createConfig({
    dataLakeId: lake.id,
    name,
    trigger: triggerFor(cadence),
    cadence,
    reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit),
    schedulePaused,
    nextRunAt: firstRunAt,
    scheduleAnchorAt: firstRunAt,
    createdByUserId: actor.userId,
    ...levers,
  });

  // `grants` comes from the caller's own gate (assertLakeResearchManage), not re-fetched here -
  // the gate and the recorded manage rung must agree on the same grant set, the same reasoning
  // reviewDataLakeProposal's resolveReviewable applies to its own reused grants.
  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'create-research-config',
      ...audit,
      target: { kind: 'researchConfig', id: created.id },
      changes: [
        researchConfigChange(name, 'created'),
        ...(levers.autoAdmitTrusted ? [researchAutoAdmitChange(name, true)] : []),
        ...itemRuleChanges(name, [], levers.itemRules),
      ],
      // A recreate from Undo records what it restored; an ordinary create has never carried levers.
      ...(audit?.undoesEventId
        ? {
            leverChanges: snapshotLeverChanges(researchConfigStateOf(created)).map(({ lever, before }) => ({
              lever,
              before: null,
              after: before,
            })),
          }
        : {}),
    },
    { db, logger }
  );

  return created;
}

export function listResearchConfigs(
  dataLakeId: string,
  { db }: ResearchConfigAdapters,
  page?: ResearchKeysetPage
): Promise<IDataLakeResearchConfigDocument[]> {
  return db.dataLakeResearchConfigs.listByLake(dataLakeId, page);
}

export async function updateResearchConfig(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  input: { name?: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, logger, now = () => new Date(), audit }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, lake.id);
  if (!existing) throw new NotFoundError('Research configuration not found');

  // A config saved before scheduling existed has no stored cadence; it reads as `off`.
  const currentCadence = existing.cadence ?? 'off';
  const cadence = resolveCadence(input, currentCadence);
  // The next slot is only reset when the cadence CHANGES, so editing a query does not push a
  // config's upcoming run a whole period out. The last outcome belonged to the old schedule.
  const at = now();
  const firstRunAt = firstResearchRunAt(cadence, at);
  const wasPaused = existing.schedulePaused === true;
  const nextPaused = resolveSchedulePaused(input.schedulePaused, cadence, wasPaused);
  const resuming = wasPaused && !nextPaused && cadence === currentCadence && cadence !== 'off';
  const schedule =
    cadence !== currentCadence
      ? {
          cadence,
          trigger: triggerFor(cadence),
          nextRunAt: firstRunAt,
          scheduleAnchorAt: firstRunAt,
          lastScheduledOutcome: null,
        }
      : resuming
        ? {
            nextRunAt: resumedNextRunAt(existing, cadence, at),
            ...(existing.lastScheduledOutcome?.outcome === 'skipped' &&
            existing.lastScheduledOutcome.reason === 'schedule_paused'
              ? { lastScheduledOutcome: null }
              : {}),
          }
        : {};

  // Normalized over the MERGE of stored and incoming, not over the patch alone: normalization needs
  // the whole lever set (an absent `query` in a patch is "unchanged", but to the normalizer an
  // absent query is a refusal), and re-normalizing the merge is also what re-clamps a stored value
  // that a tightened bound has since put out of range.
  // `allowedDomains` is dropped from the stored side: it is derived, and a stale copy next to a
  // changed tier list would read as an edit by older code.
  const { allowedDomains: _derived, ...stored } = existing;
  const mergedDraft = { ...stored, ...resolveLegacyAllowedInput(input, existing) };
  assertFeedSource(mergedDraft);
  assertItemRulesWithinLimits(mergedDraft);
  const merged = normalizeResearchLevers(mergedDraft);
  assertSourcesReachable(merged);
  assertAutoAdmitEntriesSafe(merged);
  // Compared per lever via LEVER_EQUALITY, not a JSON.stringify of two object literals:
  // `normalizeResearchLevers` omits `model`/`recencyDays` when unset, so key order differs between
  // `merged` and a hand-built object and a byte-identical default-config resubmit would read as changed.
  const nextName = input.name !== undefined ? normalizeName(input.name) : existing.name;
  const nothingMoved = nextName === existing.name && !leversDiffer(merged, existing);

  const updated = await db.dataLakeResearchConfigs.updateConfig(configId, lake.id, {
    ...merged,
    // Explicitly cleared rather than left off: `normalizeResearchLevers` OMITS `recencyDays` and
    // `model` when they are unset, and `$set` of a partial would leave the previous value in place -
    // so a user clearing either field would watch it come straight back.
    recencyDays: merged.recencyDays ?? null,
    model: merged.model ?? null,
    ...(input.name !== undefined ? { name: nextName } : {}),
    ...schedule,
    ...(nextPaused !== wasPaused ? { schedulePaused: nextPaused } : {}),
    ...(input.reviewBacklogLimit !== undefined
      ? { reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit) }
      : {}),
    lastUpdatedByUserId: actor.userId,
  });

  if (!updated) throw new NotFoundError('Research configuration not found');

  // An idempotent PUT (the submitted body matches what is already stored) genuinely changed
  // nothing, so it earns no `researchConfig: updated: <name>` row - a resubmit-without-edits is not
  // an event a History reader needs to see.
  // Outside the nothingMoved gate: a pause-only change moves no lever and must still be recorded.
  const nextBacklogLimit =
    input.reviewBacklogLimit !== undefined
      ? normalizeReviewBacklogLimit(input.reviewBacklogLimit)
      : normalizeReviewBacklogLimit(existing.reviewBacklogLimit);
  // The UPDATED document's own name, not the input: an edit that never touched `name` still reads
  // by its current name rather than by whatever this caller happened to submit.
  const { scheduleLines, leverLines, leverChanges } = diffResearchConfig(researchConfigStateOf(existing), {
    name: updated.name,
    levers: merged,
    cadence,
    reviewBacklogLimit: nextBacklogLimit,
    schedulePaused: nextPaused,
  });
  const feedUrlMoved = !LEVER_EQUALITY.feedUrl(merged.feedUrl, existing.feedUrl);
  if (nothingMoved && leverChanges.length > 0) {
    await recordLakeConfigChange(
      {
        actor,
        lake,
        grants,
        action: 'update-research-config',
        ...audit,
        target: { kind: 'researchConfig', id: configId },
        changes: scheduleLines,
        leverChanges,
      },
      { db, logger }
    );
  } else if (!nothingMoved) {
    const eventId = await recordLakeConfigChange(
      {
        actor,
        lake,
        grants,
        action: 'update-research-config',
        ...audit,
        target: { kind: 'researchConfig', id: configId },
        changes: [researchConfigChange(updated.name, 'updated'), ...scheduleLines, ...leverLines],
        leverChanges,
      },
      { db, logger }
    );
    if (feedUrlMoved) {
      await recordLakeConfigSnapshot(
        eventId,
        {
          dataLakeId: lake.id,
          kind: 'feed-url-edited',
          feedUrlBefore: existing.feedUrl ?? null,
          feedUrlAfter: merged.feedUrl ?? null,
        },
        { db, logger },
        now()
      );
    }
  }

  return updated;
}

/**
 * Pause or resume a config's schedule. Deliberately does not go through `updateResearchConfig`:
 * that re-validates every lever, so a config saved before a limit tightened could not be stopped.
 * Reads and writes propagate every repository error except a bad id (which reads as not found), so
 * a transaction write conflict reaches `withTransaction`'s retry.
 */
export async function setResearchSchedulePaused(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  paused: boolean,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  { db, logger, now = () => new Date(), audit }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, lake.id);
  if (!existing) throw new NotFoundError('Research configuration not found');

  const cadence = existing.cadence ?? 'off';
  resolveSchedulePaused(paused, cadence, false);
  if (existing.schedulePaused === paused || (!paused && cadence === 'off')) return existing;

  const at = now();
  const resume =
    !paused && cadence !== 'off'
      ? {
          nextRunAt: resumedNextRunAt(existing, cadence, at),
          ...(existing.lastScheduledOutcome?.outcome === 'skipped' &&
          existing.lastScheduledOutcome.reason === 'schedule_paused'
            ? { lastScheduledOutcome: null }
            : {}),
        }
      : {};
  const updated = await db.dataLakeResearchConfigs.updateConfig(configId, lake.id, {
    schedulePaused: paused,
    ...resume,
    lastUpdatedByUserId: actor.userId,
  });
  if (!updated) throw new NotFoundError('Research configuration not found');

  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'update-research-config',
      ...audit,
      target: { kind: 'researchConfig', id: configId },
      changes: [researchSchedulePausedChange(updated.name, paused)],
      leverChanges: [{ lever: 'schedulePaused', before: existing.schedulePaused === true, after: paused }],
    },
    { db, logger }
  );
  return updated;
}

export async function deleteResearchConfig(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  { db, logger, now = () => new Date(), audit }: ResearchConfigAdapters
): Promise<void> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, lake.id);
  if (!existing) throw new NotFoundError('Research configuration not found');

  const deleted = await db.dataLakeResearchConfigs.deleteConfig(configId, lake.id);
  if (!deleted) throw new NotFoundError('Research configuration not found');
  // Run history is deliberately NOT swept with the config: a row is what a proposal's `runId`
  // points at, and those proposals outlive the config that produced them.

  const eventId = await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'delete-research-config',
      ...audit,
      target: { kind: 'researchConfig', id: configId },
      changes: [researchConfigChange(existing.name, 'deleted')],
      leverChanges: snapshotLeverChanges(researchConfigStateOf(existing)),
    },
    { db, logger }
  );
  // The full config, feed address included, for the undo window only; the row above is redacted.
  await recordLakeConfigSnapshot(
    eventId,
    { dataLakeId: lake.id, kind: 'config-deleted', config: { ...existing } },
    { db, logger },
    now()
  );
}
