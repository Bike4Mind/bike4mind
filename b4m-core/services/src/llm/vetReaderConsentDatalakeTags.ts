/**
 * Reader-consent tags are INERT unless the request's authenticated principal IS the session
 * owner - mirrors vetPreauthorizedLakeIds' owner gate exactly (same comparison, same reasoning):
 * a request acting on someone else's session (a share, a teammate reply) must not inherit the
 * owner's consent to the lake-prompt READER OPT-IN arm (see getAccessibleDataLakePrompts).
 */
export function vetReaderConsentDatalakeTags(
  session: { userId?: string; retrievalTags?: string[] },
  actingUserId: string
): string[] | undefined {
  return session.userId === actingUserId ? session.retrievalTags : undefined;
}
