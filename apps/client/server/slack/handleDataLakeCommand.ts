import { parseDataLakeCommand, type ParsedDataLakeCommand, type SlackAttachment } from '@bike4mind/slack';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeRepository } from '@bike4mind/common';
import {
  buildSlackAccessContext,
  ingestSlackFilesIntoLake,
  type SlackIngestActor,
  type SlackLakeIngestDeps,
  type SlackLakeIngestOutcome,
} from './dataLakeFileIngest';

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
  deps: SlackLakeIngestDeps & { dataLakes: DataLakeCommandRepo };
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
  '- `@datalake list` - list the lakes you can add to',
  '- `@datalake help` - show this help',
].join('\n');

const USAGE_HINT = 'Try `@datalake help`.';

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

  const rows = writable.map(lake => `- \`${lake.slug}\` - ${lake.name}`).join('\n');
  return `*Data lakes you can add to*\n${rows}\n\nAdd to one with \`@datalake add to <lake>\` and a file attached.`;
}

async function handleAdd(
  parsed: Extract<ParsedDataLakeCommand, { subcommand: 'add' }>,
  params: HandleDataLakeCommandParams
): Promise<string> {
  if (!parsed.lakeSlug) {
    return 'Please name a target lake, e.g. `@datalake add to <lake>` with a file attached.';
  }

  // LINK ingest is M3. Refuse explicitly: accepting the command and silently ingesting nothing
  // would read as success to the person who shared the URL.
  if (params.files.length === 0 && parsed.link) {
    return 'Adding a link is not supported yet. Attach the file to your message instead.';
  }

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

  const reply = formatIngestOutcome(outcome, { autoChunkEnabled: params.autoChunkEnabled });

  // A message carrying BOTH files and a link falls past the refusal above, so say what happened
  // to the link too - ingesting the files and staying silent about the URL reads as if both
  // were taken.
  if (parsed.link) {
    // Warning sign escaped so this source file stays ASCII (same as formatIngestOutcome).
    return `${reply}\n\u26a0\ufe0f Ignored the link - links are not supported yet. Attach it as a file instead.`;
  }

  return reply;
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
    getSettingsValue(key: 'EnableDataLakeSlackAdd' | 'enableAutoChunk'): Promise<boolean | undefined>;
  };
  ingest: SlackLakeIngestDeps & { dataLakes: DataLakeCommandRepo };
  sendMessage: (args: { channel: string; text: string; threadTs?: string }) => Promise<unknown>;
  logger: { info: (message: string) => void; error: (message: string, meta?: unknown) => void };
}

/**
 * Orchestrate a `@datalake` Slack command: enforce the `EnableDataLakeSlackAdd` gate
 * (silent no-op when off, keeping the surface dormant), otherwise dispatch and reply in-thread.
 * The caller intercepts this BEFORE the LLM path and always acks Slack with 200.
 */
export async function runDataLakeSlackCommand(deps: RunDataLakeSlackCommandDeps): Promise<void> {
  // Never throw: the caller acks Slack with 200 on the next line, and an escaped exception would
  // unwind past it and trigger Slack's event retry - which, now that this path ingests files,
  // would re-download and re-create them. Log, best-effort notify, and swallow.
  try {
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
