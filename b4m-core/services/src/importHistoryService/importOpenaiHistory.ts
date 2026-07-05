import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { IChatHistoryItem } from '@bike4mind/common';
import last from 'lodash/last.js';
import { ImportHistoryAdapters } from './types';

const epochDate = () => z.preprocess(val => new Date(Number(val) * 1000), z.date());

const openaiConversationSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  create_time: epochDate(),
  update_time: epochDate().nullable(),
  mapping: z.record(
    z.string(),
    z.looseObject({
      id: z.string(),
      parent: z.string().nullable(),
      children: z.array(z.string()),
      message: z
        .looseObject({
          id: z.string(),
          create_time: epochDate(),
          update_time: epochDate().nullable(),
          author: z.looseObject({
            role: z.string(),
            name: z.string().nullable(),
            metadata: z.any(), // Accept any metadata structure
          }), // Allow extra fields in author
          content: z.looseObject({
            content_type: z.string(),
            parts: z.array(z.any()).optional(), // Accept any type in parts array (strings, objects, etc.)
          }), // Allow extra fields in content
          status: z.string(),
          end_turn: z.boolean().nullable(),
          metadata: z.any(), // Accept any metadata structure since it varies widely
          recipient: z.string(),
        }) // Allow extra fields in message
        .nullable(),
    }) // Allow extra fields in mapping node
  ),
}); // Allow extra fields in conversation

export type IOpenaiConversation = z.infer<typeof openaiConversationSchema>;
export type IOpenaiConversationMapping = IOpenaiConversation['mapping'][string];

export const processOpenaiConversation = async (
  userId: string,
  db: ImportHistoryAdapters['db'],
  rawConversation: unknown
): Promise<void> => {
  const { success, data: conversation, error } = openaiConversationSchema.safeParse(rawConversation);
  if (!success) {
    Logger.globalInstance.error('Error parsing OpenAI conversation:', error);
    return;
  }

  const rootNode = Object.values(conversation.mapping).find(c => !c.parent);
  if (!rootNode) {
    throw new Error('No root node found in conversation');
  }
  const session = await db.sessions.upsertByOpenaiConversationId(conversation.id, {
    userId,
    name: conversation.title,
    firstCreated: conversation.create_time,
    lastUpdated: conversation.update_time ?? new Date(),
    openaiConversationId: conversation.id,
  });
  const records = processOpenaiConversationNode(session.id, rootNode, conversation.mapping);
  Logger.globalInstance.log(
    `Adding ${records.length} records for userId ${userId} conversation ${conversation.id} (${conversation.title})`
  );
  await db.chatHistoryItems.bulkCreate(records);
};

export const processOpenaiConversationNode = (
  sessionId: string,
  node: IOpenaiConversationMapping,
  mappings: Record<string, IOpenaiConversationMapping>
): IChatHistoryItem[] => {
  const records: IChatHistoryItem[] = [];

  const message = node.message;
  if (message && message.content.parts?.some(m => typeof m === 'string' && m.length > 0)) {
    if (message.author.role === 'user' && node.children.length > 0) {
      // We expect the user message to have a single reply (child), and its children to be the assistant's replies.
      const intermediateId = last(node.children);
      const intermediate = intermediateId && mappings[intermediateId];
      if (!intermediate) {
        throw new Error(`Message ${message.id} is missing reply node ${intermediateId}`);
      }
      // Filter for messages that are the intermediate itself, or children of the intermediate
      // node, and are assistant messages with content
      const prompt = message.content.parts?.filter(p => typeof p === 'string').join(' ') ?? '';
      const replyMessages = Object.values(mappings).filter(
        m =>
          [m.parent, m.id].includes(intermediate.id) &&
          m.message?.author.role === 'assistant' &&
          m.message.content.parts?.some(m => typeof m === 'string' && m.length > 0)
      );
      const replies = replyMessages
        .map(r => r.message!.content.parts?.filter(p => typeof p === 'string').join(' '))
        .filter(r => !!r) as string[];
      records.push({
        sessionId,
        openaiMessageId: message.id,
        type: 'message',
        timestamp: message.create_time,
        images: [],
        prompt,
        replies,
      });
    }
  }

  if (node.children.length > 0) {
    for (const childId of node.children) {
      if (!mappings[childId]) {
        throw new Error(`Child node ${childId} not found`);
      }
      records.push(...processOpenaiConversationNode(sessionId, mappings[childId], mappings));
    }
  }

  return records;
};
