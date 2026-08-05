import { parseDataLakeCommand, type ParsedDataLakeCommand } from '@bike4mind/slack';
import type { IDataLakeDocument } from '@bike4mind/common';

/**
 * Deterministic handler for the Slack `@datalake` command (PR 1 / M1).
 *
 * PR 1 is DORMANT: `runDataLakeSlackCommand` only calls this once the
 * `EnableDataLakeSlackAdd` admin flag is on. Scope here is the grammar + lake
 * resolution by slug; the FILE/LINK ingest, the server-built AccessContext, and
 * the write gate land in later milestones (M2/M3). `list` needs that AccessContext
 * too, so it stays a placeholder until then.
 */

/** Narrowed DataLake repository surface this handler needs (injected for testability). */
export interface DataLakeCommandRepo {
  findBySlug(slug: string, organizationId?: string): Promise<IDataLakeDocument | null>;
}

export interface HandleDataLakeCommandParams {
  /** The full parsed command text, including the leading `@datalake`. */
  command: string;
  /** organizationId of the resolved B4M user; scopes slug resolution. */
  organizationId?: string;
  dataLakes: DataLakeCommandRepo;
}

const HELP_TEXT = [
  '*Data Lake commands*',
  '- `@datalake add to <lake> <link>` - add a link (or an attached file) to a lake',
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
      // Listing writable lakes needs the server-built AccessContext (arrives in M2).
      return 'Listing the lakes you can add to is coming soon.';
    case 'add':
      return handleAdd(parsed, params);
    default:
      return `Unrecognized \`@datalake\` command. ${USAGE_HINT}`;
  }
}

async function handleAdd(parsed: ParsedDataLakeCommand, params: HandleDataLakeCommandParams): Promise<string> {
  if (!parsed.lakeSlug) {
    return 'Please name a target lake, e.g. `@datalake add to <lake> <link>` (with a link or an attached file).';
  }

  const lake = await params.dataLakes.findBySlug(parsed.lakeSlug, params.organizationId);
  if (!lake) {
    return `No Data Lake \`${parsed.lakeSlug}\` found. Use \`@datalake list\` to see the lakes you can add to.`;
  }

  // Ingest (FILE/LINK) and the write-authorization check land in M2/M3.
  return `Found lake *${lake.name}*. Adding content from Slack is coming soon.`;
}

/** Dependencies for the Slack `@datalake` orchestrator (all injected for testability). */
export interface RunDataLakeSlackCommandDeps {
  /** The full parsed command text, including the leading `@datalake`. */
  command: string;
  /** organizationId of the resolved B4M user; scopes slug resolution. */
  organizationId?: string;
  channel: string;
  threadTs?: string;
  adminSettings: { getSettingsValue(key: 'EnableDataLakeSlackAdd'): Promise<boolean | undefined> };
  dataLakes: DataLakeCommandRepo;
  sendMessage: (args: { channel: string; text: string; threadTs?: string }) => Promise<unknown>;
  logger: { info: (message: string) => void };
}

/**
 * Orchestrate a `@datalake` Slack command: enforce the `EnableDataLakeSlackAdd` gate
 * (silent no-op when off, keeping PR 1 dormant), otherwise dispatch and reply in-thread.
 * The caller intercepts this BEFORE the LLM path and always acks Slack with 200.
 */
export async function runDataLakeSlackCommand(deps: RunDataLakeSlackCommandDeps): Promise<void> {
  const enabled = await deps.adminSettings.getSettingsValue('EnableDataLakeSlackAdd');
  if (!enabled) {
    deps.logger.info('Ignoring @datalake command: EnableDataLakeSlackAdd is off');
    return;
  }

  const response = await handleDataLakeCommand({
    command: deps.command,
    organizationId: deps.organizationId,
    dataLakes: deps.dataLakes,
  });
  await deps.sendMessage({ channel: deps.channel, text: response, threadTs: deps.threadTs });
}
