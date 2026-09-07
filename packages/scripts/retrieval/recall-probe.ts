#!/usr/bin/env tsx
/**
 * Retrieval-recall probe for `search_knowledge_base` (#1993).
 *
 * Measures how much of the material that could support an answer actually reaches the model, at
 * several `kbSearchResultTokenBudget` / `kbSearchMinRelevancePct` settings, so those defaults can be
 * chosen from a measurement instead of left at the conservative launch values #1955 shipped.
 *
 * WHY IT DRIVES THE TOOL RATHER THAN A CHAT TURN. #1831 measured through forced retrieval, and this
 * ticket inherited that wording - but forced retrieval is a different code path with different
 * budgets (`ChatCompletionFeatures.ts:1595` states it is NOT routed through semanticDataLakeSearch;
 * it uses `forcedRetrievalCharBudget` and a hardcoded 0.75 similarity floor). The three kb* knobs
 * are consumed in exactly one file, `knowledgeBaseSearch/index.ts`. A forced-retrieval probe would
 * have returned identical numbers at every configuration. Invoking the tool directly also removes
 * model tool-choice variance entirely, which is the variable forced retrieval was chosen to control,
 * while still exercising the shipped ranking, ceiling, floor and token-budget code rather than a
 * reimplementation that could drift from it.
 *
 * HOW IT SEES WHAT WAS SERVED. The tool already reports every read to the lake audit trail
 * (`recordLakeAccessEvent`, `knowledgeBaseSearch/index.ts:974`) carrying the deduped file ids, chunk
 * ids and per-chunk scores. That write is deliberately un-awaited, so reading the rows back out of
 * Mongo would race the probe's next question. Instead the probe supplies its own
 * `db.lakeAccessEvents` recorder - the adapter seam the ToolContext already exposes - and captures
 * the payload in memory. Same data the audit trail gets, no race, and no parsing of the
 * model-facing string the tool returns.
 *
 * The probe captures the `statusUpdate` seam alongside it, because the audit trail alone cannot say
 * whether an absent event means "retrieval served nothing" or "the harness never saw the write".
 * Unlike the audit write, every terminal path AWAITS its status write, so `promptMeta.retrieval` is
 * always present by the time `toolFn` resolves. `promptMeta.warnings` is captured from the same
 * seam and carries the tool's relevance-floor notice, which is the only thing separating "the
 * keyword arm answered because the floor under test emptied the semantic one" (a real measurement)
 * from "the keyword arm answered because the semantic one was never wired up" (a fatal harness
 * problem). See `auditEvent.ts`, which owns both decisions.
 *
 * CORPUS. The `system-help` lake: 51 public help articles, seeded by
 * `packages/scripts/help/ingest-help-datalake.ts`. See `corpus.ts` for why that corpus and why the
 * ground truth is hand-authored.
 *
 * SCOPE. This measures RECALL of the supporting set. The unverifiable-claim rate the ticket also
 * asks for needs an answer generated from the served passages plus a judge pass over its claims;
 * that arm is not built here and is required before any default is actually changed, since it is the
 * metric that can show a wider budget making answers worse rather than better.
 *
 * Usage (needs DB + an embedding key, which `sst shell` provides):
 *   npx sst shell --stage pr<N> -- tsx packages/scripts/retrieval/recall-probe.ts \
 *     --userId <probeUserId> --configs=0:0
 *
 *   --configs   sweep points as `tokenBudget:minRelevancePct`, comma separated.
 *               Defaults to `0:0`, today's shipped defaults (the baseline row).
 *   --userId    the principal the searches run as. Use an account with NO personal files: the
 *               unscoped arm ranks the caller's own library alongside the lake, and personal files
 *               would enter the corpus without being in the ground truth.
 *   --out-dir   where the JSON result lands (default packages/scripts/out, which is gitignored).
 *   --dry-run   print the plan without writing settings or sweeping. Preflight still RUNS, and it
 *               ends in a live canary search (a real embedding call) - checking that the corpus is
 *               reachable is the whole value of a dry run, so it is deliberately not skipped.
 *
 * SIDE EFFECT: the sweep WRITES the two admin settings on the target stage and restores their prior
 * values on the way out - from a `finally`, and from a SIGINT/SIGTERM handler so Ctrl-C does not
 * strand a mid-sweep configuration on the stage. It also takes a lease row for the duration, so a
 * second concurrent run refuses to start rather than capturing the first run's mutated values as
 * its baseline. They are stage-wide settings regardless, so run this against a preview you own,
 * never a stage other people are using.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  AdminSettings,
  adminSettingsRepository,
  apiKeyRepository,
  connectDB,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fallbackLakeSettingsRepository,
  organizationRepository,
  scopedSettingsRepository,
  userRepository,
} from '@bike4mind/database';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { b4mTools } from '@bike4mind/services/llm/tools';
import type { ToolContext } from '@bike4mind/services/llm/tools';
import type { IUserDocument, RecordLakeAccessEventInput, SettingKey } from '@bike4mind/common';
import { readRetrievalStatus, readServedDocuments, type CapturedPromptMeta } from './auditEvent';
import { pollFor } from './pollEvent';
import { PROBE_QUESTIONS, type ProbeQuestion } from './corpus';
import { aggregate, scoreQuestion, type QuestionOutcome } from './metrics';
import {
  BASELINE_CONFIG,
  formatConfig,
  formatSweepTable,
  parseConfigs,
  type SweepConfig,
  type SweepRow,
} from './sweep';

/** This file is packages/scripts/retrieval/, so the package root is two levels up. */
const SCRIPTS_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The lake `ingest-help-datalake.ts` creates, and the per-article tag prefix it writes. */
const HELP_LAKE_SLUG = 'system-help';
const HELP_TAG_PREFIX = 'help:';

/**
 * A deliberately easy, high-lexical-overlap query used only to prove the search path returns
 * anything at all. It is NOT part of the measured set - it breaks the corpus design rules on
 * purpose (see corpus.ts), because a precondition check wants the highest-signal query available,
 * which is exactly the opposite of what a discriminating probe question wants.
 */
const CANARY_QUESTION: ProbeQuestion = {
  id: 'canary',
  question: 'data lakes',
  supporting: ['features/data-lakes'],
};

// Typed as SettingKey so a typo fails the build rather than writing a row nothing reads.
const TOKEN_BUDGET_SETTING: SettingKey = 'kbSearchResultTokenBudget';
const MIN_RELEVANCE_SETTING: SettingKey = 'kbSearchMinRelevancePct';

const logger = new Logger();

// ---------------------------------------------------------------------------
// Capture seam
// ---------------------------------------------------------------------------

/**
 * Stands in for the two seams the probe observes one tool call through, both adapter boundaries the
 * ToolContext already exposes: the lake-audit repository (WHAT was served) and `statusUpdate` (the
 * tool's own account of WHETHER it served anything). Nothing is persisted.
 */
function createCapturingRecorder() {
  const events: RecordLakeAccessEventInput[] = [];
  const promptMetas: CapturedPromptMeta[] = [];
  return {
    events,
    promptMetas,
    recorder: {
      record: async (input: RecordLakeAccessEventInput) => {
        events.push(input);
        return undefined as unknown as never;
      },
    },
    statusUpdate: async (update?: { promptMeta?: CapturedPromptMeta }) => {
      if (update?.promptMeta) promptMetas.push(update.promptMeta);
      return undefined;
    },
    reset: () => {
      events.length = 0;
      promptMetas.length = 0;
    },
  };
}

type Capture = ReturnType<typeof createCapturingRecorder>;

/**
 * Wait out the tool's un-awaited audit write. See `pollEvent.ts`, which owns the loop and its
 * timeout semantics; this is only the binding to the capture buffer.
 */
const waitForEvent = (capture: Capture, timeoutMs?: number): Promise<RecordLakeAccessEventInput | null> =>
  pollFor(() => capture.events[0], { timeoutMs });

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

/**
 * Assemble the repository graph `search_knowledge_base` needs. Mirrors the agent executor's wiring
 * (`apps/client/server/queueHandlers/agentExecutor.ts`), minus every adapter this one tool never
 * touches - a narrower context than the real one would silently change behavior, a wider one would
 * just be noise.
 */
/**
 * The ToolContext the search tool runs on.
 *
 * The double cast is deliberate: ToolContext is shaped for a live chat turn and carries many fields
 * (session, quest, streaming, config) that a headless probe has no analogue for, so satisfying it
 * honestly would mean fabricating a turn. Only the fields the search path actually reads are wired.
 *
 * The cost is that the compiler cannot tell us when a field the search path DOES read is missing -
 * it silently reads `undefined` and the tool degrades instead of failing. That is exactly how the
 * lake-access gap produced a clean 0% across every question. The canary search in `preflight` is
 * the compensating control for this cast; do not remove one without the other.
 */
function buildToolContext(user: IUserDocument, capture: Capture) {
  return {
    userId: user.id,
    user,
    logger,
    // No sessionId/questId: this is not a chat turn. They are diagnostic join keys on the audit row
    // and are never read by the search path itself.
    db: {
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
      fabfiles: fabFileRepository,
      fabfilechunks: fabFileChunkRepository,
      users: userRepository,
      dataLakes: dataLakeRepository,
      fallbackLakeSettings: fallbackLakeSettingsRepository,
      organizations: organizationRepository,
      scopedSettings: scopedSettingsRepository,
      lakeAccessEvents: capture.recorder,
    },
    statusUpdate: capture.statusUpdate,
    onStart: async () => undefined,
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Fail before measuring anything rather than reporting a confidently wrong number.
 *
 * Each of these degrades SILENTLY in production, which is correct for a chat turn and ruinous for a
 * measurement: an unvectorized lake, a missing embedding credential or an unsupported
 * `defaultEmbeddingModel` all send `search_knowledge_base` down its keyword fallback, which ignores
 * both knobs this probe exists to sweep. The run would complete and every row would look identical.
 */
async function preflight(user: IUserDocument, capture: Capture): Promise<{ lakeId: string; fileCount: number }> {
  const lake = await dataLakeRepository.findBySlug(HELP_LAKE_SLUG);
  if (!lake) {
    throw new Error(
      `No "${HELP_LAKE_SLUG}" lake on this stage. Seed it first:\n` +
        `  pnpm --filter @bike4mind/scripts help:regenerate\n` +
        `  npx sst shell --stage <stage> -- tsx packages/scripts/help/ingest-help-datalake.ts --userId <id>`
    );
  }
  if (lake.status !== 'active') throw new Error(`Lake "${HELP_LAKE_SLUG}" is ${lake.status}, not active.`);

  const fileIds = await fabFileRepository.findIdsByDataLakeTag({
    kind: 'registry',
    datalakeTag: lake.datalakeTag,
  });
  if (fileIds.length === 0) throw new Error(`Lake "${HELP_LAKE_SLUG}" exists but holds no files. Re-run the ingest.`);

  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModel) {
    throw new Error(
      'defaultEmbeddingModel is not configured on this stage, so the semantic arm cannot run and ' +
        'search_knowledge_base would silently fall back to keyword search.'
    );
  }

  // A file with no chunks embeds to nothing and is unreachable by semantic search, so a lake that
  // ingested but never vectorized would measure as a total recall failure with no other symptom.
  let vectorized = 0;
  for (const id of fileIds) {
    if ((await fabFileChunkRepository.countByFabFileId(id)) > 0) vectorized++;
  }
  if (vectorized === 0) {
    throw new Error(`None of the ${fileIds.length} help files carry chunks. The lake was ingested but not vectorized.`);
  }
  if (vectorized < fileIds.length) {
    logger.warn(
      `Only ${vectorized}/${fileIds.length} help files are vectorized. Recall is bounded by that, ` +
        `not by the settings under test - finish the ingest before trusting these numbers.`
    );
  }

  // The harness identifies a served document by its `help:<slug>` tag, which the ingest writes
  // alongside the lake meta-tag. If that prefix ever drifts, every served file resolves to
  // UNTAGGED and recall collapses to zero across the board - which reads as a retrieval failure
  // rather than a harness bug. Pin the assumption against the live corpus, loudly, up front.
  const sample = await fabFileRepository.findById(fileIds[0]);
  if (!sample?.tags?.some(t => t.name.startsWith(HELP_TAG_PREFIX))) {
    throw new Error(
      `Help lake files do not carry a "${HELP_TAG_PREFIX}" tag, so served documents cannot be ` +
        `mapped back to help slugs. The ingest's FILE_TAG_PREFIX and this probe have drifted.`
    );
  }

  // The unscoped search arm ranks the caller's OWN library alongside the lake, and a hit on a
  // personal file is not attributable to any lake - so the tool records no audit event for it and
  // the probe would read a real result as "served nothing". Ground truth cannot describe those
  // files either. Enforce the precondition instead of documenting it.
  //
  // PARTIAL BY CONSTRUCTION: `findByUserId` returns OWNED files, while the unscoped arm ranks
  // owned plus shared plus org-shared. A file shared TO the probe user passes this check and can
  // still enter the ranking. Low impact rather than unhandled - `resolveSlugs` surfaces it as
  // `UNTAGGED:<id>` instead of dropping it, so it shows up in the detail as an intruder rather
  // than corrupting a slug - but a clean account is still the only way to rule the case out, which
  // is why the message asks for one rather than for an empty owned list.
  const ownFiles = await fabFileRepository.findByUserId(user.id);
  const ownNonLake = ownFiles.filter(f => !f.tags?.some(t => t.name.startsWith(HELP_TAG_PREFIX)));
  if (ownNonLake.length > 0) {
    throw new Error(
      `Probe user ${user.id} owns ${ownNonLake.length} file(s) outside the help lake. They would ` +
        `enter the ranking without being in the ground truth. Use a dedicated account with no files ` +
        `- note this check sees OWNED files only, so files shared to the account are not covered ` +
        `and would appear in the results as UNTAGGED:<id>.`
    );
  }

  // THE precondition every other check presupposes: that a search by THIS caller over THIS lake
  // actually returns candidates. Everything above verifies the corpus exists; none of it verifies
  // the caller can reach it. That gap is invisible downstream - a caller with no grant makes the
  // tool search an empty candidate set, report `outcome: 'ok'`, and score a clean 0 on every
  // question, which is indistinguishable from a relevance floor correctly rejecting everything.
  //
  // Empirical rather than a re-derivation of the access rules: this is a live end-to-end search, so
  // it also catches an unusable embedding credential, a tag drift, or an unvectorized corpus - any
  // reason the candidate set comes back empty, not just the one that bit us.
  //
  // It runs at whatever the stage already has configured, since the sweep has not applied anything
  // yet - so a stage carrying an aggressive floor of its own can fail this check on a lake that is
  // in fact reachable. That is the right trade: the canary's job is to turn a silent stage-wide
  // zero into a loud stop, and a false stop costs one legible error message while a false pass
  // costs a plausible, entirely wrong results table.
  const canary = await runQuestion(CANARY_QUESTION, user, capture);
  if (canary.served.length === 0) {
    throw new Error(
      `Canary search returned no documents, so the ${fileIds.length}-file lake is unreachable for ` +
        `user ${user.id} and every question would score 0% at every configuration.\n` +
        `Most likely cause: no access grant. "${HELP_LAKE_SLUG}" is gateless, org-less and not ` +
        `public, so the only arm that admits anyone is the owner bypass - run as the account in the ` +
        `lake's createdByUserId, or grant access via isPublic / requiredUserTag / organizationId.\n` +
        `Otherwise check this stage's existing ${MIN_RELEVANCE_SETTING}: the canary runs before the ` +
        `sweep applies anything, so a floor already set on the stage can suppress it.`
    );
  }

  logger.log(
    `Preflight OK: lake "${HELP_LAKE_SLUG}" (${lake.id}), ${fileIds.length} files, ` +
      `${vectorized} vectorized, embedding model ${embeddingModel}`
  );
  return { lakeId: lake.id, fileCount: fileIds.length };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Deliberately reads THROUGH the soft-delete filter (see `writeSetting`), so a tombstone left by an
 * older run of this script reads as "unset" rather than as a baseline. That is the recovering
 * answer: a tombstone's `settingValue` is whatever the interrupted sweep wrote last, never the
 * stage's real prior value, and restoring "unset" hard-deletes the row and leaves the stage clean.
 */
async function readSetting(name: string): Promise<string | null> {
  const row = await AdminSettings.findOne({ settingName: name }).lean<{ settingValue?: string } | null>();
  return row?.settingValue ?? null;
}

/**
 * Write a setting and drop the in-process caches so the next search sees it.
 *
 * Both caches must go: `resolveSearchBudgets` reads the platform value through the cached settings
 * accessor AND consults the scoped-settings overlay, each with its own ~5 minute TTL. Because the
 * probe invokes the tool in this same process, invalidating here makes a configuration take effect
 * immediately - an HTTP-driven probe would have to wait out a full TTL on every serving instance.
 *
 * BOTH BRANCHES FIGHT THE SAME SOFT-DELETE ASYMMETRY, which is invisible at the call site.
 * `AdminSettingsSchema.plugin(softDeletePlugin)` (`AdminSettingsModel.ts:47`) replaces `deleteOne`
 * with an `updateOne` that stamps `deletedAt` (`db-core/src/utils/mongo.ts:412`), and the plugin
 * filters `find`/`findOne` on `deletedAt: null` but hooks NEITHER `updateOne` NOR
 * `findOneAndUpdate`. A plain `deleteOne` here would therefore leave a tombstoned row that still
 * carries the sweep's last value: `readSetting` reports it unset, so the next run captures a false
 * baseline; the upsert below would match the tombstone without clearing `deletedAt`, so every
 * subsequent configuration writes into a document `AdminSettingsCache` cannot see and every row in
 * the table silently measures the shipped defaults. It escapes the script too - the settings API
 * saves through an unfiltered `findOneAndUpdate`, so the setting becomes permanently unsettable
 * from the admin UI on any stage this ran against.
 *
 * `hardDelete` really removes the row; `deletedAt: null` on the upsert recovers one left by an
 * older run of this script.
 */
async function writeSetting(name: string, value: string | null): Promise<void> {
  if (value === null) {
    await AdminSettings.deleteOne({ settingName: name }, { hardDelete: true });
  } else {
    await AdminSettings.updateOne(
      { settingName: name },
      { $set: { settingValue: value, deletedAt: null } },
      { upsert: true }
    );
  }
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
}

async function applyConfig(config: SweepConfig): Promise<void> {
  await writeSetting(TOKEN_BUDGET_SETTING, String(config.tokenBudget));
  await writeSetting(MIN_RELEVANCE_SETTING, String(config.minRelevancePct));
}

/**
 * A row this script owns, not a real setting - `settingsMap` has no entry for it, so every typed
 * reader ignores it. It exists only so a second concurrent run can see the first.
 */
const LEASE_SETTING = '__recallProbeLease';

/**
 * How long before a lease is reported as abandoned. Longer than any plausible sweep (30 questions x
 * a handful of configurations, each a live embedding call), so a slow run is never mistaken for a
 * dead one.
 */
const LEASE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Take exclusive ownership of the two swept settings, and hand back a `restore` that gives them
 * back exactly once.
 *
 * This is the ONLY thing standing between a dev script and a permanently altered shared stage, so
 * both ways of losing that guarantee are closed here rather than left to the caller:
 *
 * - CONCURRENCY. A second run started while a first is in flight would read the FIRST run's mutated
 *   values as its own baseline and restore those on exit, discarding the stage's real configuration
 *   with no error anywhere. The lease makes the second run refuse instead. It is a plain row rather
 *   than a Mongo lock because the two runs may be different processes on different machines.
 *
 * - INTERRUPTION. Ctrl-C is the natural reaction to a sweep that is taking too long, and it skips
 *   `finally` entirely - leaving the stage carrying whichever configuration was mid-flight, which
 *   is a live change to retrieval behaviour that nobody knows was made. The handlers below restore
 *   first and then re-raise, so the exit status still reports the signal.
 *
 * `restore` is idempotent and single-flight: the signal path and the `finally` path both call it,
 * and a second Ctrl-C during a slow restore must not start a second one.
 */
async function acquireSettingsLease(): Promise<{ restore: () => Promise<void> }> {
  const holder = `${hostname()}:${process.pid}`;
  const now = Date.now();

  // Atomic: `upsertedCount` is 1 only for the run that actually created the row. A concurrent
  // loser either matches the existing row or trips the unique index on settingName - both mean
  // somebody else holds the lease.
  let acquired = false;
  try {
    const result = await AdminSettings.updateOne(
      { settingName: LEASE_SETTING },
      { $setOnInsert: { settingValue: JSON.stringify({ holder, startedAt: now }), deletedAt: null } },
      { upsert: true }
    );
    acquired = result.upsertedCount === 1;
  } catch {
    acquired = false;
  }

  if (!acquired) {
    const existing = await readSetting(LEASE_SETTING);
    // Tolerate an unparseable row: the lease still BLOCKS either way, and a SyntaxError here would
    // replace the message that tells the operator what to do with one that does not.
    let startedAt = 0;
    try {
      startedAt = Number(JSON.parse(existing ?? '{}')?.startedAt ?? 0);
    } catch {
      startedAt = 0;
    }
    const ageMs = now - startedAt;
    const age =
      Number.isFinite(ageMs) && startedAt > 0 ? `${Math.round(ageMs / 60_000)} minute(s) ago` : 'at an unknown time';
    const staleHint =
      startedAt > 0 && ageMs > LEASE_STALE_AFTER_MS
        ? `\nThat lease is older than ${LEASE_STALE_AFTER_MS / 3_600_000}h, so the run holding it probably died. ` +
          `Confirm no sweep is running, CHECK ${TOKEN_BUDGET_SETTING} and ${MIN_RELEVANCE_SETTING} against ` +
          `what this stage should have, then clear the "${LEASE_SETTING}" row to release it.`
        : '';
    throw new Error(
      `Another recall probe holds the settings lease on this stage (${existing ?? 'holder unknown'}, taken ${age}). ` +
        `Refusing to start: this run would capture that run's mutated settings as its baseline and ` +
        `restore those on exit, permanently discarding the stage's real configuration.${staleHint}`
    );
  }

  // Captured AFTER the lease so nothing else can be mid-sweep, and BEFORE the first write so the
  // restore puts back whatever the stage had, including "unset" - writing a 0 back would leave a
  // row where there was none and quietly change how a future reader interprets the stage config.
  const original: Record<string, string | null> = {
    [TOKEN_BUDGET_SETTING]: await readSetting(TOKEN_BUDGET_SETTING),
    [MIN_RELEVANCE_SETTING]: await readSetting(MIN_RELEVANCE_SETTING),
  };

  let inFlight: Promise<void> | null = null;
  const runRestore = async (): Promise<void> => {
    // Never let a restore failure replace the error that actually ended the run - a mid-run DB
    // outage takes these writes down with it, and an unguarded await here would surface the
    // cleanup's socket timeout while hiding the cause. The stage is left mutated either way, so
    // the values needed to undo it by hand are printed rather than merely logged as a failure.
    const stranded: string[] = [];
    for (const [name, value] of Object.entries(original)) {
      try {
        await writeSetting(name, value);
      } catch (err) {
        stranded.push(`${name}=${value ?? '(unset)'}`);
        logger.warn(`Could not restore ${name}`, err);
      }
    }
    // Released last: while any setting is still stranded the lease is the only marker that this
    // stage is mid-sweep, and a run that starts against a half-restored stage is the corruption
    // the lease exists to prevent.
    if (stranded.length > 0) {
      logger.error(
        `SETTINGS LEFT MODIFIED ON THIS STAGE. Restore by hand: ${stranded.join(', ')} ` +
          '("(unset)" means delete the row rather than writing a 0 - a 0 row and no row read the ' +
          'same to the search path today, but not to a human reading the stage config later.) ' +
          `Then clear the "${LEASE_SETTING}" row, which is deliberately left behind to block the ` +
          'next run until you have.'
      );
      return;
    }
    try {
      await writeSetting(LEASE_SETTING, null);
    } catch (err) {
      logger.warn(`Could not release the "${LEASE_SETTING}" row. Clear it by hand before the next run.`, err);
      return;
    }
    logger.log('\nRestored the original settings values.');
  };

  const restore = (): Promise<void> => (inFlight ??= runRestore());

  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      logger.warn(`\nReceived ${signal}. Restoring the stage settings before exiting.`);
      await restore();
      // Re-raise with our handler gone so the process dies of the signal it was sent and the exit
      // status stays honest (128+n), rather than reporting a clean exit from an aborted sweep.
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.kill(process.pid, signal);
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    restore: async () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await restore();
    },
  };
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

/**
 * Map served file ids back to help slugs via the `help:<slug>` tag the ingest writes, which is the
 * only stable identity a file has across re-ingests (ids are regenerated every run, since the ingest
 * deletes and recreates the corpus).
 */
async function resolveSlugs(fileIds: readonly string[]): Promise<string[]> {
  const slugs: string[] = [];
  for (const id of fileIds) {
    const file = await fabFileRepository.findById(id);
    // Tags are {name, strength} objects, not bare strings - see IFabFile.tags.
    const tag = file?.tags?.find(t => t.name.startsWith(HELP_TAG_PREFIX));
    // A served file with no help tag is a real signal, not noise to drop: it means something outside
    // the corpus entered the ranking, and the ground truth cannot describe it.
    slugs.push(tag ? tag.name.slice(HELP_TAG_PREFIX.length) : `UNTAGGED:${id}`);
  }
  return slugs;
}

type QuestionResult = {
  id: string;
  question: string;
  supporting: string[];
  served: string[];
  outcome: QuestionOutcome;
};

async function runQuestion(question: ProbeQuestion, user: IUserDocument, capture: Capture): Promise<QuestionResult> {
  capture.reset();
  const context = buildToolContext(user, capture);
  const tool = b4mTools.search_knowledge_base.implementation(context, {});
  await tool.toolFn({ query: question.question });

  // Awaited by the tool on every terminal path, so it is already captured. Only the un-awaited
  // audit write needs waiting for, and only when this says one is coming - so a negative question
  // now costs no wall clock instead of burning the full timeout to learn nothing.
  const status = readRetrievalStatus(capture.promptMetas);
  const event = status.kind === 'served-content' ? await waitForEvent(capture) : (capture.events[0] ?? null);
  const reading = readServedDocuments(event, status);

  if (reading.kind === 'unmeasurable') {
    throw new Error(
      `Question ${question.id} produced no measurable result: ${reading.reason} Refusing to score ` +
        `it as a zero, which would be indistinguishable from the relevance floor doing its job.`
    );
  }

  if (reading.kind === 'keyword-fallback') {
    throw new Error(
      `Question ${question.id} fell through to KEYWORD search (audit row carried no chunk scores) ` +
        `WITHOUT the relevance-floor notice, so the semantic arm was never available rather than ` +
        `emptied by the floor under test. This configuration was never exercised. Check the ` +
        `embedding credential and defaultEmbeddingModel on this stage.`
    );
  }

  const served = reading.kind === 'served' ? await resolveSlugs(reading.fileIds) : [];
  return { ...question, served, outcome: scoreQuestion(served, new Set(question.supporting)) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option('userId', { type: 'string', demandOption: true, describe: 'Principal the searches run as' })
    .option('configs', { type: 'string', default: '0:0', describe: 'tokenBudget:minRelevancePct, comma separated' })
    // packages/scripts/out/ is gitignored; the repo root's out/ is not, so defaulting to cwd
    // dropped an untracked result file into the repo whenever this ran from the root.
    .option('out-dir', { type: 'string', default: path.resolve(SCRIPTS_PACKAGE_DIR, 'out') })
    .option('dry-run', { type: 'boolean', default: false })
    .strict()
    .parse();

  const configs = parseConfigs(argv.configs);
  if (
    !configs.some(
      c => c.tokenBudget === BASELINE_CONFIG.tokenBudget && c.minRelevancePct === BASELINE_CONFIG.minRelevancePct
    )
  ) {
    // Without the off/off row there is nothing to read the other rows against: a recall number means
    // "better or worse than what ships today", and today is 0/0.
    logger.warn(
      `--configs omits the ${formatConfig(BASELINE_CONFIG)} baseline. Rows will have nothing to compare against.`
    );
  }

  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
  logger.log(`Connected (stage: ${Resource.App.stage})`);

  const user = await userRepository.findById(argv.userId);
  if (!user) throw new Error(`No user ${argv.userId} on this stage.`);

  const capture = createCapturingRecorder();
  const { lakeId, fileCount } = await preflight(user, capture);

  if (argv['dry-run']) {
    logger.log(
      `Dry run. Would sweep ${configs.length} configuration(s) over ${PROBE_QUESTIONS.length} questions ` +
        `against lake ${lakeId} (${fileCount} files) as ${user.id}:\n  ` +
        configs.map(formatConfig).join('\n  ')
    );
    return;
  }

  const rows: SweepRow[] = [];
  const detail: Record<string, QuestionResult[]> = {};

  const { restore } = await acquireSettingsLease();

  try {
    for (const config of configs) {
      await applyConfig(config);
      logger.log(`\n=== ${formatConfig(config)} ===`);

      const results: QuestionResult[] = [];
      for (const question of PROBE_QUESTIONS) {
        const result = await runQuestion(question, user, capture);
        results.push(result);
        logger.log(
          `  ${result.id}  served ${result.outcome.documentsServed}  recall ${(result.outcome.recall * 100).toFixed(0)}%`
        );
      }
      detail[formatConfig(config)] = results;
      rows.push({ ...config, aggregate: aggregate(results.map(r => r.outcome)) });
    }
  } finally {
    // Restores every setting and releases the lease, even if a question threw. Idempotent with the
    // signal handlers the lease installed, so an interrupted run does not restore twice.
    await restore();
  }

  const table = formatSweepTable(rows);
  logger.log(`\n${table}\n`);

  mkdirSync(argv['out-dir'], { recursive: true });
  const outPath = path.join(argv['out-dir'], 'retrieval-recall-probe.json');
  writeFileSync(
    outPath,
    // No timestamp: the run's provenance is the stage and the corpus, and a timestamp would make two
    // otherwise-identical runs diff noisily when they are checked into a ticket.
    JSON.stringify({ lakeId, corpusFiles: fileCount, questions: PROBE_QUESTIONS.length, rows, detail }, null, 2)
  );
  logger.log(`Wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
