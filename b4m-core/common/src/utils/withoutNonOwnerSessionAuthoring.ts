/**
 * The session as a turn by `actingUserId` may see it: a session's own `systemPromptText` and
 * `enabledTools` apply only to its owner's turns. A collaborator chatting in a shared notebook
 * runs tools with their own access, so they never get instructions or forced tools they cannot
 * read. Apply before `applyWorkspaceSessionSettings`, so fields a workspace resolves server-side
 * are kept. Returns the input unchanged for the owner.
 */
export function withoutNonOwnerSessionAuthoring<
  TSession extends { userId?: unknown; systemPromptText?: string; enabledTools?: string[]; toJSON?: () => unknown },
>(session: TSession, actingUserId: string): TSession {
  if (String(session.userId) === actingUserId) return session;
  if (session.systemPromptText === undefined && session.enabledTools === undefined) return session;
  const plain = (typeof session.toJSON === 'function' ? session.toJSON() : session) as TSession;
  const { systemPromptText: _prompt, enabledTools: _tools, ...rest } = plain;
  return rest as TSession;
}
