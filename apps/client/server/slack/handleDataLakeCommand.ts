import { parseDataLakeCommand, type ParsedDataLakeCommand, type SlackAttachment } from '@bike4mind/slack';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeRepository } from '@bike4mind/common';
import { buildSlackAccessContext, type SlackIngestActor } from './dataLakeIngestAuthz';
import { ingestSlackFilesIntoLake, type SlackLakeIngestDeps, type SlackLakeIngestOutcome } from './dataLakeFileIngest';
import { ingestSlackLinkIntoLake, type SlackLinkIngestDeps, type SlackLinkIngestOutcome } from './dataLakeLinkIngest';

/**
 * Deterministic handler for the Slack `@datalake` command.
 *
 * M1 landed the grammar behind the `EnableDataLakeSlackAdd` flag; M2 fills in the FILE ingest
 * (see `dataLakeFileIngest.ts`, which owns lake resolution and the write gate) and `list`. LINK
 * ingest is M3 - a bare URL is refused here rather than silently ignored.
 *
 * The whole surface stays DORMANT: `runDataLakeSlackCommand` only reaches this once the admin
 * flag is on, and the flag stays off until M4.
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

/**
 * The lakes the caller may ADD to - i.e. `canManage` (admin or creator), not merely readable.
 * Listing everything they can read would advertise lakes every add would then refuse.
 */
async function handleList(params: HandleDataLakeCommandParams): Promise<string> {
  const ctx = await buildSlackAccessContext(params.actor, params.deps);
  const lakes = await dataLakeService.listDataLakes(ctx, { db: { dataLakes: params.deps.dataLakes } });
  const writable = lakes.filter(lake => lake.canManage);

  if (writable.length === 0) {
    return 'You cannot add to any data lakes yet. You can add to lakes you created, or ask an admin.';
  }

  // Capped: for an ADMIN, findAccessible short-circuits to every draft/active lake on the
  // platform, all canManage. Past Slack's 40k-character `text` limit chat.postMessage errors, the
  // orchestrator catches it, and the admin gets "something went wrong" instead of any list at all.
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
  const replies: string[] = [];

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
    replies.push(formatIngestOutcome(outcome, { autoChunkEnabled: params.autoChunkEnabled }));
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
    replies.push(formatLinkOutcome(outcome, { autoChunkEnabled: params.autoChunkEnabled }));
  }

  if (replies.length === 0) {
    return 'Attach a file or include a link to add something to a data lake.';
  }

  // Both halves authorize independently (see the note on the paired calls above), so an actor who is
  // refused gets the SAME refusal sentence from each - which reads as a stutter rather than as two
  // half-outcomes. Collapse exact duplicates while preserving order: two genuine outcomes always
  // differ, because each names its own file or link.
  return [...new Set(replies)].join('\n');
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
 * Orchestrate a `@datalake` Slack command: enforce the admin gates (silent no-op when off, keeping
 * the surface dormant), otherwise dispatch and reply in-thread. The caller intercepts this BEFORE
 * the LLM path and always acks Slack with 200.
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
