// Extracted from @bike4mind/utils/src/llm/utils.ts - these functions only depend on @bike4mind/common
import type { IMessage, MessageContentObject, MessageContentText, MessageContentToolUse } from '@bike4mind/common';

/**
 * Ensures that tool_use and tool_result blocks are properly paired in messages.
 * This function handles both cases by:
 * - Removing orphaned tool_result blocks that reference tool_use_ids that no longer exist
 * - Removing orphaned tool_use blocks that don't have corresponding tool_result blocks
 */
export const ensureToolPairingIntegrity = (
  messages: IMessage[],
  logger?: { log: (msg: string) => void; warn: (msg: string) => void }
): IMessage[] => {
  // Early exit if no messages
  if (messages.length === 0) {
    return messages;
  }

  // First pass: collect all tool_use IDs and tool_result IDs
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  let hasToolUseBlocks = false;
  let hasToolResultBlocks = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content;
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_use' && 'id' in block) {
          toolUseIds.add(block.id as string);
          hasToolUseBlocks = true;
        }
      }
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content;
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          toolResultIds.add(block.tool_use_id as string);
          hasToolResultBlocks = true;
        }
      }
    }
  }

  // Early exit: if no tool blocks exist at all, nothing to validate
  if (!hasToolUseBlocks && !hasToolResultBlocks) {
    return messages;
  }

  // Diagnostic logging: report tool block inventory
  if (logger) {
    const toolUseArray = Array.from(toolUseIds);
    const toolResultArray = Array.from(toolResultIds);

    // Find mismatches before removal
    const orphanedToolUseIds = toolUseArray.filter(id => !toolResultIds.has(id));
    const orphanedToolResultIds = toolResultArray.filter(id => !toolUseIds.has(id));

    if (orphanedToolUseIds.length > 0 || orphanedToolResultIds.length > 0) {
      logger.warn(
        `[Tool Pairing Diagnostic #6181] Messages: ${messages.length}, ` +
          `tool_use IDs: [${toolUseArray.join(', ')}], ` +
          `tool_result IDs: [${toolResultArray.join(', ')}], ` +
          `orphaned tool_use: [${orphanedToolUseIds.join(', ')}], ` +
          `orphaned tool_result: [${orphanedToolResultIds.join(', ')}]`
      );
    }
  }

  // Second pass: filter orphaned blocks and build result array
  let orphanedToolResultCount = 0;
  let orphanedToolUseCount = 0;
  const result: IMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Handle assistant messages - check for orphaned tool_use blocks
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content as MessageContentObject[];
      let hasOrphanedToolUse = false;

      // Check if any tool_use blocks lack corresponding tool_result
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_use' && 'id' in block) {
          if (!toolResultIds.has(block.id as string)) {
            hasOrphanedToolUse = true;
            break;
          }
        }
      }

      if (!hasOrphanedToolUse) {
        result.push(message);
        continue;
      }

      // Filter out orphaned tool_use blocks
      const filteredContent: MessageContentObject[] = [];
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_use' && 'id' in block) {
          const toolId = block.id as string;
          if (!toolResultIds.has(toolId)) {
            orphanedToolUseCount++;
            if (logger) {
              logger.warn(`Removing orphaned tool_use block with id: ${toolId} (no matching tool_result)`);
            }
            continue; // Skip this block
          }
        }
        filteredContent.push(block);
      }

      // Only add message if it has remaining content
      if (filteredContent.length > 0) {
        result.push({ ...message, content: filteredContent });
      }
      continue;
    }

    // Handle user messages - check for orphaned tool_result blocks
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content as MessageContentObject[];
      let hasOrphanedToolResult = false;

      // Check if any tool_result blocks lack corresponding tool_use
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          if (!toolUseIds.has(block.tool_use_id as string)) {
            hasOrphanedToolResult = true;
            break;
          }
        }
      }

      if (!hasOrphanedToolResult) {
        result.push(message);
        continue;
      }

      // Filter out orphaned tool_result blocks
      const filteredContent: MessageContentObject[] = [];
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          const toolUseId = block.tool_use_id as string;
          if (!toolUseIds.has(toolUseId)) {
            orphanedToolResultCount++;
            if (logger) {
              logger.warn(`Removing orphaned tool_result block referencing missing tool_use_id: ${toolUseId}`);
            }
            continue; // Skip this block
          }
        }
        filteredContent.push(block);
      }

      // Only add message if it has remaining content
      if (filteredContent.length > 0) {
        result.push({ ...message, content: filteredContent });
      }
      continue;
    }

    // Pass through other messages unchanged
    result.push(message);
  }

  if ((orphanedToolResultCount > 0 || orphanedToolUseCount > 0) && logger) {
    const parts: string[] = [];
    if (orphanedToolResultCount > 0) {
      parts.push(`${orphanedToolResultCount} orphaned tool_result block(s)`);
    }
    if (orphanedToolUseCount > 0) {
      parts.push(`${orphanedToolUseCount} orphaned tool_use block(s)`);
    }
    logger.log(`Tool pairing integrity: removed ${parts.join(' and ')} after truncation`);
  }

  // Third pass: adjacency validation - Anthropic requires tool_result immediately after tool_use
  // Walk messages and ensure assistant messages with tool_use are immediately followed by
  // a user message with matching tool_result IDs. Only strip unmatched tool_use blocks;
  // keep any that have valid adjacent results.
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const content = msg.content as MessageContentObject[];
    const toolUseBlockIds = content
      .filter(b => b.type === 'tool_use' && 'id' in b)
      .map(b => (b as MessageContentToolUse).id);

    if (toolUseBlockIds.length === 0) continue;

    // Determine which tool_use IDs have matching adjacent tool_result blocks
    const adjacentResultIds = new Set<string>();
    const nextMsg = result[i + 1];
    if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
      const nextContent = nextMsg.content as MessageContentObject[];
      for (const b of nextContent) {
        if (b.type === 'tool_result' && 'tool_use_id' in b) {
          adjacentResultIds.add((b as { tool_use_id: string }).tool_use_id);
        }
      }
    }

    // Find which IDs are NOT matched
    const unmatchedIds = toolUseBlockIds.filter(id => !adjacentResultIds.has(id));
    if (unmatchedIds.length === 0) continue; // All matched, adjacency is correct

    // Surgical removal: only strip unmatched tool_use blocks, keep matched ones and text
    const unmatchedSet = new Set(unmatchedIds);
    const filtered = content.filter(b => {
      if (b.type === 'tool_use' && 'id' in b && unmatchedSet.has((b as MessageContentToolUse).id)) {
        return false;
      }
      return true;
    });

    if (filtered.length > 0) {
      result[i] = { ...msg, content: filtered };
    } else {
      // Message was only unmatched tool_use blocks - replace with empty text to preserve structure
      result[i] = {
        ...msg,
        content: [{ type: 'text', text: '[Tool calls removed during message repair]' } as MessageContentText],
      };
    }

    if (logger) {
      logger.warn(
        `[Tool Pairing Adjacency] Stripped ${unmatchedIds.length} non-adjacent tool_use block(s) from message ${i} (IDs: ${unmatchedIds.join(', ')})`
      );
    }

    // Also clean up orphaned tool_result blocks for the unmatched IDs from all subsequent user messages
    for (let j = i + 1; j < result.length; j++) {
      const laterMsg = result[j];
      if (laterMsg?.role !== 'user' || !Array.isArray(laterMsg.content)) continue;

      const laterContent = laterMsg.content as MessageContentObject[];
      const cleanedContent = laterContent.filter(b => {
        if (
          b.type === 'tool_result' &&
          'tool_use_id' in b &&
          unmatchedSet.has((b as { tool_use_id: string }).tool_use_id)
        ) {
          return false;
        }
        return true;
      });

      if (cleanedContent.length > 0) {
        if (cleanedContent.length !== laterContent.length) {
          result[j] = { ...laterMsg, content: cleanedContent };
        }
      } else {
        // Message only contained orphaned tool_result blocks - preserve structure with a placeholder
        result[j] = { ...laterMsg, content: '[Tool results removed during adjacency repair]' };
      }
    }
  }

  return result;
};

/**
 * Last-resort recovery: strips ALL tool_use and tool_result blocks from messages.
 * This degrades conversation history (loses tool context) but allows the completion
 * to proceed when tool pairing is irrecoverably broken.
 */
export const stripAllToolBlocks = (
  messages: IMessage[],
  logger?: { log: (msg: string) => void; warn: (msg: string) => void }
): IMessage[] => {
  let strippedToolUse = 0;
  let strippedToolResult = 0;
  const result: IMessage[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    const content = message.content as MessageContentObject[];
    const filtered = content.filter(block => {
      if (block.type === 'tool_use') {
        strippedToolUse++;
        return false;
      }
      if (block.type === 'tool_result') {
        strippedToolResult++;
        return false;
      }
      return true;
    });

    // If message still has content after stripping, keep it
    if (filtered.length > 0) {
      result.push({ ...message, content: filtered });
    } else if (message.role === 'user') {
      // Preserve user messages with placeholder text so conversation structure isn't broken
      result.push({ ...message, content: '[Tool results removed during error recovery]' });
    }
    // Drop assistant messages that were only tool_use blocks
  }

  if ((strippedToolUse > 0 || strippedToolResult > 0) && logger) {
    logger.warn(
      `[Tool Pairing Recovery] Stripped ${strippedToolUse} tool_use and ${strippedToolResult} tool_result blocks from history`
    );
  }

  return result;
};
