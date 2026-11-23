import {
  isReadOnlyMcpConnectionTool,
  type IMcpConnectionPublic,
  type IntegrationId,
  type McpConnectionEffectiveStatus,
  type McpConnectionListEntry,
  type McpToolApprovalMode,
} from '@bike4mind/common';
import type { McpToolReviewEntry } from '@client/app/hooks/data/mcpConnections';
import type { ConnectionState } from '../galleryModel';

export type McpConnectionTool = IMcpConnectionPublic['tools'][number];

export type StatusColor = 'success' | 'warning' | 'danger' | 'neutral';

export const STATUS_CHIPS: Record<
  McpConnectionEffectiveStatus | 'pending_review',
  { label: string; color: StatusColor }
> = {
  connected: { label: 'Connected', color: 'success' },
  pending_auth: { label: 'Needs sign-in', color: 'warning' },
  needs_reconnect: { label: 'Needs reconnect', color: 'warning' },
  error: { label: 'Error', color: 'danger' },
  blocked_by_policy: { label: 'Blocked by admin', color: 'neutral' },
  pending_review: { label: 'Pending review', color: 'warning' },
};

/**
 * The chip a connection shows. A connected server with tools waiting for review reads as Pending
 * review, because none of those tools are offered until the user saves a review.
 */
export const connectionChip = (connection: IMcpConnectionPublic) =>
  connection.status === 'connected' && pendingReviewCount(connection) > 0
    ? STATUS_CHIPS.pending_review
    : STATUS_CHIPS[connection.status];

export const pendingReviewCount = (connection: Pick<IMcpConnectionPublic, 'tools'>): number =>
  connection.tools.filter(tool => tool.state === 'pending_review').length;

const isOfferedTool = (tool: Pick<McpConnectionTool, 'enabled' | 'state'>) => tool.enabled && tool.state === 'active';

/** Tools the model is offered: enabled and reviewed. */
export const offeredToolCount = (connection: Pick<IMcpConnectionPublic, 'tools'>): number =>
  connection.tools.filter(isOfferedTool).length;

/**
 * What a connector's tool list shows its user: the tools offered to them, and for their own
 * connector how many others it has (switched off or waiting for review). A platform connector's
 * member view carries only what it offers, so it is listed as served.
 */
export const connectorToolsOffered = (
  connection: Pick<McpConnectionListEntry, 'ownerType' | 'tools'>
): { tools: McpConnectionTool[]; otherCount: number } => {
  if (connection.ownerType === 'platform') return { tools: connection.tools, otherCount: 0 };
  const tools = connection.tools.filter(isOfferedTool);
  return { tools, otherCount: connection.tools.length - tools.length };
};

/** The tool's display title, when the server gave one. */
export const toolTitle = (tool: Pick<McpConnectionTool, 'title' | 'annotations'>): string | undefined =>
  tool.title || tool.annotations?.title || undefined;

/**
 * The server's hints as short labels. Read and Write follow the tool review (same rule, same
 * words); the other hints show only when declared true, and on a read-only tool only open world.
 * Every label is the server's own claim, and the wording says so where it asserts safety.
 */
export const toolHintLabels = (
  tool: Pick<McpConnectionTool, 'annotations'>
): { label: string; color: 'neutral' | 'warning' }[] => {
  const hints = tool.annotations ?? {};
  const readOnly = isReadOnlyMcpConnectionTool(tool);
  return [
    readOnly ? { label: 'Read', color: 'neutral' as const } : { label: 'Write', color: 'warning' as const },
    ...(!readOnly && hints.destructiveHint === true
      ? [{ label: 'May delete or overwrite', color: 'neutral' as const }]
      : []),
    ...(!readOnly && hints.idempotentHint === true
      ? [{ label: 'Server says it is safe to repeat', color: 'neutral' as const }]
      : []),
    ...(hints.openWorldHint === true ? [{ label: 'May reach other services', color: 'neutral' as const }] : []),
  ];
};

/** A connector's tool list gets a filter field only past this many tools. */
export const TOOL_FILTER_THRESHOLD = 10;

/** Tools whose title, name or description contains the query, ignoring case. */
export const filterConnectorTools = (tools: readonly McpConnectionTool[], query: string): McpConnectionTool[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tools];
  return tools.filter(tool =>
    [toolTitle(tool), tool.name, tool.description].some(text => text?.toLowerCase().includes(needle))
  );
};

/**
 * Connectors the composer can switch per chat: connected, switched on (in Integrations, or by an
 * admin for a platform connector), and with at least one reviewed tool on. Anything else
 * contributes no tools, so a row for it would toggle nothing.
 */
export const composerConnections = (connections: readonly McpConnectionListEntry[]): McpConnectionListEntry[] =>
  connections.filter(c => c.status === 'connected' && c.enabled && offeredToolCount(c) > 0);

/**
 * What a Tools-menu row reads under the connector's name: the description with a host line under
 * it, else the host line alone. The host stays visible either way.
 */
export const connectionMenuText = (
  connection: Pick<McpConnectionListEntry, 'ownerType' | 'urlHost' | 'description'>
): { description: string; detail?: string } => {
  const platform = connection.ownerType === 'platform';
  if (!connection.description) {
    return {
      description: platform
        ? `Connector set up by an admin on ${connection.urlHost}`
        : `Custom connector on ${connection.urlHost}`,
    };
  }
  return {
    description: connection.description,
    detail: platform ? `Set up by an admin on ${connection.urlHost}` : `Custom connector on ${connection.urlHost}`,
  };
};

/** The trimmed fields an Edit details save changes; an emptied description is sent as '' to clear it. */
export const connectionDetailsPatch = (
  connection: Pick<IMcpConnectionPublic, 'displayName' | 'description'>,
  draft: { displayName: string; description: string }
): { displayName?: string; description?: string } => {
  const displayName = draft.displayName.trim();
  const description = draft.description.trim();
  return {
    ...(displayName !== connection.displayName ? { displayName } : {}),
    ...(description !== (connection.description ?? '') ? { description } : {}),
  };
};

/** The Tools-menu choices that decide which connectors a chat is offered (see LLMContext). */
export interface ComposerConnectionChoices {
  disabledMcpConnections: readonly string[];
  enabledPlatformMcpConnections: readonly string[];
}

type ComposerConnectionKey = Pick<McpConnectionListEntry, 'id' | 'slug' | 'ownerType'>;

/**
 * A platform connector is on only once the user switched it on, by id, so a recreated one starts
 * off; the user's own connector is on unless switched off, by slug.
 */
export const isComposerConnectionOn = (connection: ComposerConnectionKey, choices: ComposerConnectionChoices) =>
  connection.ownerType === 'platform'
    ? choices.enabledPlatformMcpConnections.includes(connection.id)
    : !choices.disabledMcpConnections.includes(connection.slug);

/** The one choice list that flipping this connector's switch changes, as an LLMContext update. */
export const toggleComposerConnection = (
  connection: ComposerConnectionKey,
  choices: ComposerConnectionChoices
): { disabledMcpConnections?: string[]; enabledPlatformMcpConnections?: string[] } => {
  const on = isComposerConnectionOn(connection, choices);
  if (connection.ownerType === 'platform') {
    const ids = choices.enabledPlatformMcpConnections;
    return { enabledPlatformMcpConnections: on ? ids.filter(id => id !== connection.id) : [...ids, connection.id] };
  }
  const slugs = choices.disabledMcpConnections;
  return { disabledMcpConnections: on ? [...slugs, connection.slug] : slugs.filter(slug => slug !== connection.slug) };
};

/** Needs a browser sign-in: waiting for the first one, or the grant expired. API keys are re-entered instead. */
export const needsSignIn = (connection: IMcpConnectionPublic): boolean =>
  connection.auth.kind !== 'api_key' &&
  (connection.status === 'pending_auth' || connection.status === 'needs_reconnect');

/**
 * The user's own connections the drawer of `presetId` manages; the custom connector entry manages
 * those with no preset. A platform connector is an admin's to manage, so no drawer lists it.
 */
export const connectionsFor = (
  connections: readonly McpConnectionListEntry[],
  presetId: IntegrationId | undefined
): IMcpConnectionPublic[] =>
  connections.filter(
    (c): c is IMcpConnectionPublic => c.ownerType !== 'platform' && (presetId ? c.presetId === presetId : !c.presetId)
  );

/** Gallery connection state for one entry: connected when any of its connections is. */
export const galleryConnectionState = (connections: readonly IMcpConnectionPublic[]): ConnectionState => ({
  connected: connections.some(c => c.status === 'connected'),
  needsReconnect:
    !connections.some(c => c.status === 'connected') && connections.some(c => c.status === 'needs_reconnect'),
});

export interface ToolDraft {
  enabled: boolean;
  approval: McpToolApprovalMode;
}

/**
 * The review form's starting point. A tool pending review always starts switched off, whatever
 * its stored `enabled` flag says, so saving without touching it never turns on a tool nobody looked at.
 */
export const initialToolDrafts = (tools: readonly McpConnectionTool[]): Record<string, ToolDraft> =>
  Object.fromEntries(
    tools.map(tool => [tool.name, { enabled: tool.state === 'active' ? tool.enabled : false, approval: tool.approval }])
  );

/**
 * Saving the review marks every listed tool reviewed (`active`), with the choices on screen. Each
 * entry names the version shown, so a tool that changed in the meantime fails the save (409).
 */
export const toReviewEntries = (
  tools: readonly McpConnectionTool[],
  drafts: Record<string, ToolDraft>
): McpToolReviewEntry[] =>
  tools
    .filter(tool => tool.versionHash)
    .map(tool => ({
      name: tool.name,
      versionHash: tool.versionHash as string,
      enabled: drafts[tool.name]?.enabled ?? false,
      approval: drafts[tool.name]?.approval ?? tool.approval,
      state: 'active' as const,
    }));
