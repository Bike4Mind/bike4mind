import { z } from 'zod';

/**
 * How the turn that runs a tool was authenticated - the positive signal on ToolContext.authOrigin.
 *
 * - `session`: a signed-in user drove the turn interactively (web/app JWT, or the CLI on the user's
 *   own machine).
 * - `apiKey`: a `b4m_live_` key authenticated the turn; ToolContext.apiKeyId names the key.
 * - `internal`: neither - the platform runs the turn on a user's behalf (Slack, embed widget,
 *   scheduled and deep agents, proactive messages, research tasks), or the origin was lost
 *   (a message queued before the field existed).
 *
 * A tool that must refuse anything but a signed-in session checks `authOrigin === 'session'` and
 * fails closed otherwise; it must never infer a session from a missing `apiKeyId`.
 */
export const AuthOriginSchema = z.enum(['session', 'apiKey', 'internal']);
export type AuthOrigin = z.infer<typeof AuthOriginSchema>;

/**
 * Throws when `authOrigin` and `apiKeyId` disagree: a key turn must name its key (attribution), and
 * a key id on any other origin means a door mislabeled a key turn.
 */
export function assertAuthOriginMatchesApiKey(authOrigin: AuthOrigin, apiKeyId: string | undefined): void {
  if ((authOrigin === 'apiKey') !== Boolean(apiKeyId)) {
    throw new Error(
      `authOrigin '${authOrigin}' does not match apiKeyId (${apiKeyId ? 'present' : 'absent'}); ` +
        "an 'apiKey' turn must carry its key id and no other origin may"
    );
  }
}
