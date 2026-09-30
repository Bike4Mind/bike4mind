import { IChatHistoryItemRepository, ISessionRepository, IUserDocument, sanitizeSessionTitle } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { stripToolOutputMarker } from '@bike4mind/utils/artifactParser';
import { z } from 'zod';

const autoNameParameterSchema = z.object({
  sessionId: z.string(),
  /** The maximum number of words to include in the title */
  maxWords: z.number().optional(),
});
type AutoNameParameters = z.infer<typeof autoNameParameterSchema>;

// `sanitizeSessionTitle` is the canonical sanitizer in `@bike4mind/common`,
// shared with the client-side display formatter. Re-exported so existing
// importers of this module keep working.
export { sanitizeSessionTitle };

interface AutoNameAdapters {
  db: {
    sessions: ISessionRepository;
    quests: IChatHistoryItemRepository;
  };
  createCompletion: (prompt: string) => Promise<string>;
  logger: Logger;
}

/**
 * @param writer - the user a request-driven rename acts for. When set, the write re-checks their
 *   update access (global-write included, matching the route's 'write' gate) and not-deleted, so a
 *   revoke or delete during the LLM call makes it a NotFoundError. Omitted for the system rename.
 */
export async function autoName(
  params: AutoNameParameters,
  adapters: AutoNameAdapters,
  writer?: Pick<IUserDocument, 'id' | 'groups'>
) {
  const { db, createCompletion, logger } = adapters;
  const { sessionId, maxWords = 5 } = secureParameters(params, autoNameParameterSchema);

  const session = await db.sessions.findById(sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const recentHistory = await db.quests.getMostRecentChatHistory(sessionId, 10);
  if (recentHistory.length < 1) {
    logger.info(`No chat history found for session ${sessionId}. Skipping auto-naming.`);
    return session;
  }

  const content = recentHistory
    .map(quest => {
      const reply = stripToolOutputMarker(quest.reply || quest.replies?.join('\n') || '');
      const hasReply = reply.trim().length > 0;

      // For queries without replies (e.g., image generation), just show the request
      if (!hasReply) {
        return `Request: ${quest.prompt}`;
      }

      // For queries with replies, show both question and answer
      return [`Question: ${quest.prompt}`, `Answer: ${reply}`].join('\n');
    })
    .join('\n\n');

  const prompt = `Give a title to this session of messages in ${maxWords} words or less.

Note: Some entries may be requests (like image generation) without text responses.

IMPORTANT: Respond with ONLY the title text. Do not include quotes, asterisks, bold formatting, or phrases like "The title is". Just output the plain title text directly.

${content}`;

  const rawTitle = await createCompletion(prompt);
  const title = sanitizeSessionTitle(rawTitle);

  if (writer) {
    const updated = await db.sessions.updateWithUpdateAccess(
      writer,
      { id: sessionId, name: title, isAutoNamed: true },
      { includeGlobalWrite: true }
    );
    if (!updated) throw new NotFoundError('Session not found');
    return updated;
  }

  await db.sessions.update({ id: sessionId, name: title, isAutoNamed: true });
  const updatedSession = await db.sessions.findById(sessionId);

  return updatedSession;
}
