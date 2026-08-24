import { parseDataLakeCommand, type ParsedDataLakeCommand, type SlackAttachment } from '@bike4mind/slack';
import { dataLakeService } from '@bike4mind/services';
import { STATIC_LAKE_IDS } from '@bike4mind/common';
import type { AccessContext, IDataLakeRepository, ManageableDataLakeConfig } from '@bike4mind/common';
import { buildSlackAccessContext, type SlackIngestActor } from './dataLakeIngestAuthz';
import { ingestSlackFilesIntoLake, type SlackLakeIngestDeps, type SlackLakeIngestOutcome } from './dataLakeFileIngest';
import { ingestSlackLinkIntoLake, type SlackLinkIngestDeps, type SlackLinkIngestOutcome } from './dataLakeLinkIngest';

/**
 * Deterministic handler for the Slack `@datalake` command.
 *
 * The grammar landed first, then the FILE ingest (see `dataLakeFileIngest.ts`, which owns lake
 * resolution and the write gate) and `list`, then LINK ingest - a bare URL is refused here rather
 * than silently ignored.
 *
 * This surface is now LIVE BY DEFAULT. `EnableDataLakeSlackAdd` defaults on, so the effective gate
 * is the parent `EnableDataLakes` - which still defaults OFF, so nothing reaches here on a deployment
 * that has never enabled Data Lakes.
 *
 * Both flags are DEPLOYMENT-GLOBAL, not per-org: `adminSettingsRepository.getSettingsValue` is a
 * `findOne({ settingName })` against a collection keyed on `settingName` alone, and this path never
 * touches the scoped-override machinery in `@bike4mind/utils` settings. So the bound is "the whole
 * deployment, once Data Lakes is on" - do NOT read it as a per-org opt-in. The child flag is the
 * off switch and rollback lever for that deployment; see `runDataLakeSlackCommand` below, which
 * enforces both.
 */

/** DataLake repository surface the command needs (injected for testability). */
export type DataLakeCommandRepo = Pick<
  IDataLakeRepository,
  'findById' | 'findBySlug' | 'findByDatalakeTag' | 'find' | 'findAccessible'
>;

export interface HandleDataLakeCommandParams {
  /** The full parsed command text, including the leading `@datalake`. */
  command: string;
  /** The resolved B4M user behind the Slack message - never derived from the event body. */
  actor: SlackIngestActor;
  /** Attachments on the Slack message, if any. */
  files: SlackAttachment[];
  channel: string;
  messageTs: string;
  deps: SlackLakeIngestDeps & SlackLinkIngestDeps & { dataLakes: DataLakeCommandRepo };
  /**
   * Whether the `enableAutoChunk` admin setting is on. Only affects the wording of the success
   * reply: with it off, `objectCreated.ts` never enqueues the chunk job, so promising the file
   * will become searchable would be untrue. Defaults to the setting's own default (true).
   */
  autoChunkEnabled?: boolean;
}

const HELP_TEXT = [
  '*Data Lake commands*',
  '- `@datalake add to <lake>` with a file attached - add that file to a lake',
  '- `@datalake add to <lake> <link>` - fetch a link and add it to a lake',
  '- `@datalake list` - list the lakes you can add to',
  '- `@datalake help` - show this help',
].join('\n');

const USAGE_HINT = 'Try `@datalake help`.';

/** Rows shown by `list` before a "+N more" tail. Keeps the reply well inside Slack's 40k limit. */
const LIST_LIMIT = 50;

export async function handleDataLakeCommand(params: HandleDataLakeCommandParams): Promise<string> {
  const parsed = parseDataLakeCommand(params.command);

  switch (parsed.subcommand) {
    case 'help':
      return HELP_TEXT;
    case 'list':
      return handleList(params);
    case 'add':
      return handleAdd(parsed, params);
    default:
      return `Unrecognized \`@datalake\` command. ${USAGE_HINT}`;
  }
}

/** The lake fields the `list` scoping rules and the rendered rows need. */
type ListableLake = Pick<ManageableDataLakeConfig, 'id' | 'slug' | 'name' | 'organizationId' | 'canManage'>;

/** The caller facts both scoping rules key off. */
type ListScope = Pick<AccessContext, 'isAdmin' | 'organizationIds'>;

/** An org-scoped lake's org id, with a blank string read as org-less (both forms are stored). */
const lakeOrgId = (lake: ListableLake): string | undefined => lake.organizationId?.trim() || undefined;

/**
 * Whether the caller may WRITE to this lake. `canManage` arrives computed under the
 * isAdmin-suppressed context (see `handleList`), so a platform admin's own manage rung is restored
 * here - EXCEPT on a built-in registry lake, which is read-only for everyone including admins
 * (`assertLakeWritable`; `listDataLakes` stamps every fallback `canManage: false` for that reason).
 * Restoring it there would advertise a lake `add` always refuses.
 */
const isWritable = (lake: ListableLake, scope: ListScope): boolean =>
  lake.canManage || (scope.isAdmin && !STATIC_LAKE_IDS.has(lake.id));

/**
 * Whether `@datalake add to <slug>` can RESOLVE this lake for this caller: an org-less lake, or one
 * scoped to an org the caller belongs to. Mirrors `findBySlug`'s own-org-then-org-less lookup
 * (packages/database/src/models/ai/DataLakeModel.ts) and must stay in sync with it - a row that
 * fails there is a slug this reply promised and `add` then refuses as "No Data Lake found".
 */
const isSlugAddressable = (lake: ListableLake, scope: ListScope): boolean => {
  const orgId = lakeOrgId(lake);
  return !orgId || (scope.organizationIds ?? []).includes(orgId);
};

/**
 * Of two lakes sharing a slug, the one `findBySlug` would resolve: an org-scoped lake beats an
 * org-less one, and among org-scoped ones the lowest org id wins (the model sorts ascending).
 */
const preferredBySlug = (a: ListableLake, b: ListableLake): ListableLake => {
  const aOrg = lakeOrgId(a);
  const bOrg = lakeOrgId(b);
  if (!aOrg) return bOrg ? b : a;
  if (!bOrg) return a;
  return bOrg < aOrg ? b : a;
};

/**
 * One row per slug. A slug is unique per org, so a collision means two lakes the caller can reach
 * under one name - keep the one `add` would resolve, or the reply names a lake the command does not
 * target. Runs over every ADDRESSABLE lake, before the write gate, because `findBySlug` resolves by
 * org priority without consulting write access (see the note in `handleList`).
 */
const dedupeBySlug = (lakes: ListableLake[]): ListableLake[] => {
  const bySlug = new Map<string, ListableLake>();
  for (const lake of lakes) {
    const existing = bySlug.get(lake.slug);
    bySlug.set(lake.slug, existing ? preferredBySlug(existing, lake) : lake);
  }
  return Array.from(bySlug.values());
};

/**
 * The lakes the caller may ADD to (see `isWritable`), not merely read. Listing everything they can
 * read would advertise lakes every add would then refuse.
 *
 * Two scoping rules, both needed, because `list` and `add` resolve lakes differently:
 *
 * 1. The row set is queried with the platform-admin bypass SUPPRESSED, so an admin's reply is built
 *    from the same org/visibility arms as everyone else's. Left on, `findAccessible` short-circuits
 *    to every draft/active lake on the platform - and unlike the web manager list, this reply is a
 *    channel message, so that set lands somewhere shared, searchable and permanent.
 * 2. Every surviving row must be addressable BY SLUG for this caller, because `add` resolves through
 *    the org-scoped `findBySlug` while `findAccessible`'s public arm ignores the org constraint.
 *
 * The invariant is "listed implies addable", NOT the converse: a lake an admin could write to purely
 * by platform-admin power, holding no ownership or org claim on it, stays out of the channel.
 */
async function handleList(params: HandleDataLakeCommandParams): Promise<string> {
  // Entitlement keys are resolved even for an admin, unlike the write path: rule 1 evaluates them
  // through the non-admin arms, so without the keys an entitlement-gated lake in the admin's OWN
  // org would fail findAccessible's requirement constraint and vanish from a list `add` still takes.
  const ctx = await buildSlackAccessContext(params.actor, params.deps, { resolveEntitlementsForAdmin: true });
  const lakes = await dataLakeService.listDataLakes(
    { ...ctx, isAdmin: false },
    { db: { dataLakes: params.deps.dataLakes } }
  );
  // Order matters, and it mirrors `add`: resolve the slug's winning lake FIRST, then apply the write
  // gate to that winner. `findBySlug` picks by org priority alone and never falls back when the lake
  // it picked turns out to be unwritable, so gating before the dedupe would hide a higher-priority
  // lake and print a slug `add` resolves elsewhere and refuses. `isWritable` also restores the
  // manage LABEL that suppressing isAdmin silenced in canManageLake; it only ever removes rows.
  const addressable = lakes.filter(lake => isSlugAddressable(lake, ctx));
  const writable = dedupeBySlug(addressable).filter(lake => isWritable(lake, ctx));

  if (writable.length === 0) {
    return 'You cannot add to any data lakes yet. You can add to lakes you created, or ask an admin.';
  }

  // Capped: a caller in a large org can still have more manageable lakes than fit Slack's
  // 40k-character `text` limit, and past it chat.postMessage errors, the orchestrator catches it,
  // and they get "something went wrong" instead of any list at all.
  const shown = writable.slice(0, LIST_LIMIT);
  const rows = shown.map(lake => `- \`${lake.slug}\` - ${lake.name}`).join('\n');
  const more = writable.length > shown.length ? `\n- ...and ${writable.length - shown.length} more` : '';
  return `*Data lakes you can add to*\n${rows}${more}\n\nAdd to one with \`@datalake add to <lake>\` and a file attached.`;
}

async function handleAdd(
  parsed: Extract<ParsedDataLakeCommand, { subcommand: 'add' }>,
  params: HandleDataLakeCommandParams
): Promise<string> {
  if (!parsed.lakeSlug) {
    return 'Please name a target lake, e.g. `@datalake add to <lake>` with a file attached.';
  }

  // Attachments and a link are both ingested now (M3), so a message carrying both gets both done
  // and both reported. This replaces M2's "Ignored the link" note, which existed only because LINK
  // ingest did not exist yet - keeping it would now under-report what actually happened.
  //
  // NOTE, deliberate: on a mixed message each ingest runs its OWN authorize-first prologue, so the
  // lake is resolved and gated twice. That duplication is the price of neither path owning the
  // other's security gate - the whole reason `dataLakeIngestAuthz` exists - and it is bounded (one
  // extra lake lookup, only when a single message carries both a file and a link). The user-visible
  // half of the cost, a refusal printed twice, is handled where the replies are joined below.
  //
  // `ok` is carried alongside the text because only REFUSALS are de-duplicated - see the join.
  const replies: Array<{ text: string; ok: boolean }> = [];

  if (params.files.length > 0) {
    const outcome = await ingestSlackFilesIntoLake(
      {
        actor: params.actor,
        lakeSlug: parsed.lakeSlug,
        files: params.files,
        channel: params.channel,
        messageTs: params.messageTs,
      },
      params.deps
    );
    replies.push({
      text: formatIngestOutcome(outcome, { autoChunkEnabled: params.autoChunkEnabled }),
      ok: outcome.ok,
    });
  }

  if (parsed.link) {
    const outcome = await ingestSlackLinkIntoLake(
      {
        actor: params.actor,
        lakeSlug: parsed.lakeSlug,
        link: parsed.link,
        channel: params.channel,
        messageTs: params.messageTs,
      },
      params.deps
    );
    replies.push({ text: formatLinkOutcome(outcome, { autoChunkEnabled: params.autoChunkEnabled }), ok: outcome.ok });
  }

  if (replies.length === 0) {
    return 'Attach a file or include a link to add something to a data lake.';
  }

  // Both halves authorize independently (see the note on the paired calls above), so an actor who is
  // refused gets the SAME refusal sentence from each - which reads as a stutter rather than as two
  // half-outcomes. Collapse those, preserving order.
  //
  // REFUSALS ONLY, deliberately. Two successes could in principle format identically - same lake, and
  // a file whose name happens to match the link's page title - and collapsing one of those would
  // under-report a write that really happened. A duplicated refusal is cosmetic; a swallowed success
  // is a lie about what is in the lake.
  const seenRefusals = new Set<string>();
  return replies
    .filter(reply => {
      if (reply.ok) return true;
      if (seenRefusals.has(reply.text)) return false;
      seenRefusals.add(reply.text);
      return true;
    })
    .map(reply => reply.text)
    .join('\n');
}

/**
 * Reply for a link add. Deliberately routed through `formatIngestOutcome` on the success path
 * rather than duplicating its wording: a link-sourced file goes through the same S3 ObjectCreated ->
 * chunk -> vectorize pipeline, so the searchability caveat about `enableAutoChunk` applies to it
 * identically and must not be allowed to drift between the two paths.
 */
export function formatLinkOutcome(outcome: SlackLinkIngestOutcome, opts: { autoChunkEnabled?: boolean } = {}): string {
  if (!outcome.ok) return outcome.message;

  return formatIngestOutcome(
    { ok: true, lakeName: outcome.lakeName, added: [outcome.fileName], duplicates: [], rejected: [] },
    opts
  );
}

/**
 * Compose the in-thread reply. Confirms "added, processing" and STOPS - there is no
 * post-vectorization "now live" update in this rollout, because nothing in the pipeline emits a
 * signal this handler could await (fabFileVectorize only reaches the browser).
 */
export function formatIngestOutcome(
  outcome: SlackLakeIngestOutcome,
  opts: { autoChunkEnabled?: boolean } = {}
): string {
  if (!outcome.ok) return outcome.message;

  const { lakeName, added, duplicates, rejected } = outcome;
  // Mirrors the setting's own default (settings.ts `enableAutoChunk`, defaultValue true), so an
  // unset flag reads as on rather than warning about indexing that is in fact running.
  const autoChunkEnabled = opts.autoChunkEnabled ?? true;
  const lines: string[] = [];

  if (added.length > 0) {
    const names = added.map(name => `"${name}"`).join(', ');
    // With enableAutoChunk off, objectCreated.ts never enqueues the chunk job, so the file is
    // stored but never indexed - promising searchability would be a lie the user cannot act on.
    const tail = autoChunkEnabled
      ? 'Processing now - it will be searchable once indexing finishes.'
      : 'Automatic indexing is off, so it will not be searchable until an admin reprocesses it.';
    lines.push(`Added ${added.length} file${added.length === 1 ? '' : 's'} to *${lakeName}*: ${names}. ` + tail);
  }

  if (duplicates.length > 0) {
    const names = duplicates.map(name => `"${name}"`).join(', ');
    lines.push(`Already in *${lakeName}*, skipped: ${names}.`);
  }

  if (rejected.length > 0) {
    // Warning sign, escaped so this source file stays ASCII.
    lines.push(...rejected.map(reason => `\u26a0\ufe0f ${reason}`));
  }

  if (lines.length === 0) {
    return `Nothing to add to *${lakeName}*. Attach a file to your message.`;
  }

  return lines.join('\n');
}

/** Dependencies for the Slack `@datalake` orchestrator (all injected for testability). */
export interface RunDataLakeSlackCommandDeps {
  /** The full parsed command text, including the leading `@datalake`. */
  command: string;
  actor: SlackIngestActor;
  files: SlackAttachment[];
  channel: string;
  messageTs: string;
  threadTs?: string;
  adminSettings: {
    getSettingsValue(
      key: 'EnableDataLakes' | 'EnableDataLakeSlackAdd' | 'enableAutoChunk'
    ): Promise<boolean | undefined>;
  };
  ingest: SlackLakeIngestDeps & SlackLinkIngestDeps & { dataLakes: DataLakeCommandRepo };
  sendMessage: (args: { channel: string; text: string; threadTs?: string }) => Promise<unknown>;
  logger: { info: (message: string) => void; error: (message: string, meta?: unknown) => void };
}

/**
 * Orchestrate a `@datalake` Slack command: enforce the admin gates (silent no-op when either is
 * off), otherwise dispatch and reply in-thread. The caller intercepts this BEFORE the LLM path and
 * always acks Slack with 200.
 *
 * BOTH `EnableDataLakes` and `EnableDataLakeSlackAdd` must be on. The child flag declares
 * `dependsOn: 'EnableDataLakes'`, so the admin UI hides it while the parent is off - but that is a
 * UI affordance, not an enforcement point, and a direct settings-store write could leave the child
 * on under a disabled parent. Checking the parent here is what actually holds.
 */
export async function runDataLakeSlackCommand(deps: RunDataLakeSlackCommandDeps): Promise<void> {
  // Never throw: the caller acks Slack with 200 on the next line, and an escaped exception would
  // unwind past it and trigger Slack's event retry - which, now that this path ingests files,
  // would re-download and re-create them. Log, best-effort notify, and swallow.
  try {
    const parentEnabled = await deps.adminSettings.getSettingsValue('EnableDataLakes');
    if (!parentEnabled) {
      deps.logger.info('Ignoring @datalake command: EnableDataLakes is off');
      return;
    }

    const enabled = await deps.adminSettings.getSettingsValue('EnableDataLakeSlackAdd');
    if (!enabled) {
      deps.logger.info('Ignoring @datalake command: EnableDataLakeSlackAdd is off');
      return;
    }

    // Read alongside the gate rather than inside the formatter: it only shapes the reply wording,
    // and a settings read per reply is cheaper here than threading a repository into formatting.
    const autoChunkEnabled = await deps.adminSettings.getSettingsValue('enableAutoChunk');

    const response = await handleDataLakeCommand({
      command: deps.command,
      actor: deps.actor,
      files: deps.files,
      channel: deps.channel,
      messageTs: deps.messageTs,
      deps: deps.ingest,
      autoChunkEnabled,
    });
    await deps.sendMessage({ channel: deps.channel, text: response, threadTs: deps.threadTs });
  } catch (err) {
    deps.logger.error('@datalake command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await deps.sendMessage({
        channel: deps.channel,
        text: 'Something went wrong handling that `@datalake` command. Please try again.',
        threadTs: deps.threadTs,
      });
    } catch {
      // Best-effort error reply; ignore a secondary sendMessage failure so we still ack 200.
    }
  }
}
