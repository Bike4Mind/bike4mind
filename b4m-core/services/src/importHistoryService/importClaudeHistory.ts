import { Logger } from '@bike4mind/observability';
import { ImportHistoryAdapters } from './types';
import { IChatHistoryItem } from '@bike4mind/common';
import { z } from 'zod';

const claudeChatMessageSchema = z.looseObject({
  uuid: z.uuid(),
  text: z.string(),
  content: z.array(
    z.looseObject({
      type: z.string(), // Accept any type: "text", "image", "tool_result", etc.
      text: z.string().optional(), // Make text optional since tool_result may not have it
    }) // Allow all other fields
  ),
  sender: z.enum(['human', 'assistant']),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  attachments: z.array(z.any()), // Accept any attachment structure
  files: z.array(z.any()), // Accept any file structure
}); // Allow extra message fields

const claudeConversationSchema = z.looseObject({
  uuid: z.uuid(),
  name: z.string(),
  summary: z.string().optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  account: z.looseObject({
    uuid: z.uuid(),
  }),
  chat_messages: z.array(claudeChatMessageSchema),
}); // Allow extra conversation fields

export const processClaudeConversation = async (
  userId: string,
  db: ImportHistoryAdapters['db'],
  rawConversation: unknown
): Promise<void> => {
  const { success, data: conversation, error } = claudeConversationSchema.safeParse(rawConversation);
  if (!success) {
    Logger.globalInstance.error('Error parsing Claude conversation:', error);
    return;
  }

  // Upsert the Session for this conversation
  const session = await db.sessions.upsertByClaudeConversationId(conversation.uuid, {
    userId,
    claudeConversationId: conversation.uuid,
    firstCreated: conversation.created_at,
    lastUpdated: conversation.updated_at,
    name: conversation.name,
  });

  // Upsert the ChatHistoryItems for this conversation.  We need to walk through
  // chat_messages looking for alternating human/assistant messages, consolidating
  // them into our single prompt-with-reply records.
  let lastMessage: IChatHistoryItem | undefined = undefined;
  const records: IChatHistoryItem[] = [];
  for (const claudeChatMessage of conversation.chat_messages) {
    // Skip empty messages (messages with no text content)
    if (!claudeChatMessage.text.trim()) {
      continue;
    }

    if (claudeChatMessage.sender === 'human') {
      if (lastMessage) {
        // We're accumulating a human-generated message already, so we'll need
        // to save that record first...
        records.push(lastMessage);
      }

      // This is a human statement (prompt), so we'll start a new record
      lastMessage = {
        claudeMessageId: claudeChatMessage.uuid,
        status: 'done',
        timestamp: claudeChatMessage.created_at,
        type: 'message',
        sessionId: session.id,
        prompt: claudeChatMessage.text,
        replies: [],
      };
    } else if (claudeChatMessage.sender === 'assistant') {
      // If we've already got an assistant reply, then we save it
      // and create a new reply record.
      if (lastMessage?.replies?.length) {
        records.push(lastMessage);
        lastMessage = undefined;
      }

      lastMessage ??= {
        claudeMessageId: claudeChatMessage.uuid,
        status: 'done',
        timestamp: claudeChatMessage.created_at,
        type: 'message',
        sessionId: session.id,
        prompt: '',
        replies: [],
      };

      /*
       * `text` may have some embeddings within:
       *   <antThinking>...</antThinking>: Signifies some markup on the artifact that follows
       *   <antArtifact>,,,</antArtifact>: An embedded file or script to be shared with the user
       *
       * TODO: Handle those by converting to Knowledge records.  Part of the trickiness
       *    is that we need to track the files has having been created from this message,
       *    so that if we need to re-import this conversation, we don't create duplicate
       *    Knowledge records.  For now, we don't process these embeddings at all, and
       *    will need to re-process them later to handle it.
       */
      lastMessage.replies!.push(claudeChatMessage.text);
    }
  }
  if (lastMessage) {
    records.push(lastMessage);
  }

  // Save the records
  await db.chatHistoryItems.bulkCreate(records);

  // TODO: Send records to queue for tagging and summarizing
};
