import type {
  IMcpConnectionPublic,
  IntegrationId,
  McpConnectionEffectiveStatus,
  McpToolApprovalMode,
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

/** Tools the model is offered: enabled and reviewed. */
export const offeredToolCount = (connection: Pick<IMcpConnectionPublic, 'tools'>): number =>
  connection.tools.filter(tool => tool.enabled && tool.state === 'active').length;

/**
 * Same rule as the server's approval gate: only `readOnlyHint` without `destructiveHint` runs
 * without asking; a missing or contradictory hint counts as a write. Keep in sync with the
 * read-only classification of custom connector tools in @bike4mind/services.
 */
export const isReadOnlyTool = (tool: Pick<McpConnectionTool, 'annotations'>): boolean =>
  tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;

/** Needs a browser sign-in: waiting for the first one, or the grant expired. API keys are re-entered instead. */
export const needsSignIn = (connection: IMcpConnectionPublic): boolean =>
  connection.auth.kind !== 'api_key' &&
  (connection.status === 'pending_auth' || connection.status === 'needs_reconnect');

/** Connections the drawer of `presetId` manages; the custom connector entry manages those with no preset. */
export const connectionsFor = (
  connections: readonly IMcpConnectionPublic[],
  presetId: IntegrationId | undefined
): IMcpConnectionPublic[] => connections.filter(c => (presetId ? c.presetId === presetId : !c.presetId));

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
