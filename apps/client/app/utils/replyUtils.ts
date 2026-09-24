import { THINK_CLOSE_TAG, THINK_OPEN_TAG, visibleReplyText } from '@bike4mind/common';

export function extractReplies(messageData: { reply?: string | null; replies?: string[] | undefined }) {
  // Prefer the authoritative array when present, because the server streams into replies[0]
  const sourceReplies =
    Array.isArray(messageData.replies) && messageData.replies.length > 0
      ? messageData.replies
      : messageData.reply
        ? [messageData.reply]
        : [];

  // Process and deduplicate short repeated segments that can occur during streaming
  const processedParts: string[] = [];
  for (const part of sourceReplies) {
    if (!part || !part.trim()) continue;

    // Shared with the TTFVT latency metric, which must consider text "seen" only once this
    // renders it - see visibleReplyText in @bike4mind/common.
    const cleaned = visibleReplyText(part);

    if (!cleaned) continue;

    // Drop exact duplicates of the immediately previous segment
    const prev = processedParts.length > 0 ? processedParts[processedParts.length - 1] : '';
    if (prev && prev === cleaned) {
      continue;
    }

    processedParts.push(cleaned);
  }

  const combined = processedParts.join('');
  return combined ? [combined] : [];
}

export function extractThinking(messageData: { reply?: string | null; replies?: string[] | undefined }) {
  // Handle both reply and replies arrays
  let initialReplies: string[] = [];

  if (messageData.reply) {
    initialReplies.push(messageData.reply);
  }

  if (messageData.replies && messageData.replies.length > 0) {
    initialReplies = messageData.reply ? initialReplies.concat(messageData.replies) : messageData.replies;
  }

  // Extract thinking content from each reply
  const thinkingParts = initialReplies
    .filter(r => r && r.trim()) // Remove empty or null replies
    .flatMap(extractThinkingBlocks)
    .filter(thinking => thinking && thinking.trim());

  return thinkingParts.join('\n\n');
}

/**
 * Every thinking block in one reply slot, in order.
 *
 * A turn that answers, calls a tool and thinks again reopens its thinking inside the slot
 * that already holds the partial answer (the provider restarts its content-block indices -
 * see appendStreamedChunk), so a slot holds neither exactly one block nor one that
 * necessarily starts at position 0. A trailing block with no close marker is still streaming
 * and is taken as-is.
 */
function extractThinkingBlocks(reply: string): string[] {
  const blocks: string[] = [];

  let cursor = 0;
  for (;;) {
    const open = reply.indexOf(THINK_OPEN_TAG, cursor);
    if (open === -1) break;

    const contentStart = open + THINK_OPEN_TAG.length;
    const close = reply.indexOf(THINK_CLOSE_TAG, contentStart);
    if (close === -1) {
      blocks.push(reply.substring(contentStart).trim());
      break;
    }

    blocks.push(reply.substring(contentStart, close).trim());
    cursor = close + THINK_CLOSE_TAG.length;
  }

  return blocks;
}
