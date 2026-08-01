import { CONTENT_READ_TOOL } from './agentExecutor.firstIterationQuery';

/**
 * Session-scoped tool policy for the agent_executor path.
 *
 * `chat_completion` applies the session's tool contract to every request
 * (`ChatCompletionProcess`: union `enabledTools`, subtract `disabledTools`, honor
 * `disableUserIntegrations`). The agent path historically applied NONE of it - it resolved tools
 * purely from the orchestration profile / start payload - so a product surface's curated session
 * meant one thing in chat and something else the moment the routing classifier upgraded the same
 * send to Agent mode.
 *
 * This module closes the subtractive half of that gap, and guarantees an attached file is
 * readable. It deliberately does NOT union `session.enabledTools`: an orchestration profile is a
 * narrowing of the toolbelt on purpose, and unioning the session's chat toolset back in would
 * dissolve every profile (a curated surface's session typically names its whole chat toolset, so
 * the profile's allowedTools would stop meaning anything). Additive session semantics stay a
 * chat-path concept; the agent path gets its additions from its profile.
 *
 * Extracted as a pure function so the policy is unit-testable without agentExecutor's server-only
 * dependency graph - same reason `agentExecutor.firstIterationQuery.ts` and
 * `agentExecutor.optiProfile.ts` are separate modules.
 */

/**
 * Tools that reach the user's own agent roster. `session.disableUserIntegrations` promises "no
 * user MCP servers, no agent delegation" (see `IDataLakeSession.disableUserIntegrations` in
 * SessionTypes), and the chat path enforces the delegation half by refusing to build an
 * agentStore. The agent path uses its agentStore for run-as-agent resolution too, so it enforces
 * the same contract by denying the delegation TOOLS rather than by tearing down the store: an
 * explicit `@agent` run stays possible, but the loop cannot fan out on its own.
 */
export const DELEGATION_TOOLS = ['delegate_to_agent', 'coordinate_task'] as const;

interface PolicyLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SessionToolPolicyInput {
  /** The run's resolved toolbelt before session policy (profile + mission + lattice names). */
  toolNames: readonly string[];
  session: {
    disabledTools?: string[] | null;
    disableUserIntegrations?: boolean | null;
  };
  /**
   * The orchestration profile's explicit denials. A profile that deliberately denies the content
   * reader keeps it denied even for a run carrying attachments - the honest "cannot read them"
   * preamble in `buildFirstIterationQuery` is the outcome there, not a silent re-add.
   */
  profileDeniedTools?: readonly string[];
  /**
   * Whether this run carries any attached file (per-message, workbench, or session knowledge).
   * Attachments imply the ability to read them: the preamble hands the agent a fabFileId and
   * tells it to fetch content, so a toolbelt without the reader turns an attachment into a dead
   * end the user experiences as "the agent can't see my file".
   */
  hasAttachments: boolean;
  logger?: PolicyLogger;
}

/**
 * Returns the final tool-name list for the run. Input order is preserved; a guaranteed reader is
 * appended. Removals always win over the attachment-driven addition, so an explicit denial - from
 * either the profile or the session - is never silently overridden.
 */
export function applySessionToolPolicy(input: SessionToolPolicyInput): string[] {
  const { toolNames, session, profileDeniedTools = [], hasAttachments, logger } = input;

  const sessionDenied = new Set(session.disabledTools ?? []);
  const profileDenied = new Set(profileDeniedTools);
  const result = [...toolNames];

  // Attachment-driven reader guarantee. Checked BEFORE the removals rather than added blindly and
  // stripped after, so the log line can't claim an addition that the next step deletes.
  if (
    hasAttachments &&
    !result.includes(CONTENT_READ_TOOL) &&
    !profileDenied.has(CONTENT_READ_TOOL) &&
    !sessionDenied.has(CONTENT_READ_TOOL)
  ) {
    result.push(CONTENT_READ_TOOL);
    logger?.info('[SessionToolPolicy] Added the content reader for a run carrying attachments', {
      tool: CONTENT_READ_TOOL,
    });
  }

  const denied = new Set(sessionDenied);
  if (session.disableUserIntegrations) {
    for (const tool of DELEGATION_TOOLS) denied.add(tool);
  }
  if (denied.size === 0) return result;

  return result.filter(tool => !denied.has(tool));
}

/**
 * Whether the run carries any attached file. Reads the ids the dispatch forwarded plus the
 * session's live knowledge pool - the same three sources `buildFirstIterationQuery` merges - so
 * the two agree on what "has attachments" means without this having to hit the database.
 * Ids that turn out to be inaccessible still count here; the preamble builder resolves them and
 * is the one that reports a partial resolution.
 */
export function runHasAttachments(
  execution: { messageFileIds?: string[] | null; sessionFabFileIds?: string[] | null },
  sessionKnowledgeIds: readonly string[] | null | undefined
): boolean {
  return (
    (execution.messageFileIds?.length ?? 0) > 0 ||
    (execution.sessionFabFileIds?.length ?? 0) > 0 ||
    (sessionKnowledgeIds?.length ?? 0) > 0
  );
}
