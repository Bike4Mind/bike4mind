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

    // Strip <think> ... </think>
    let cleaned = part;
    if (cleaned.includes('<think>') && cleaned.includes('</think>')) {
      const thinkEndIndex = cleaned.lastIndexOf('</think>');
      cleaned = cleaned.substring(thinkEndIndex + '</think>'.length).trim();
    } else if (cleaned.startsWith('<think>') && !cleaned.includes('</think>')) {
      cleaned = '';
    }

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
    .map(reply => {
      if (reply.includes('<think>') && reply.includes('</think>')) {
        const thinkStartIndex = reply.indexOf('<think>');
        const thinkEndIndex = reply.indexOf('</think>');
        return reply.substring(thinkStartIndex + '<think>'.length, thinkEndIndex).trim();
      }
      if (reply.startsWith('<think>') && !reply.includes('</think>')) {
        return reply.substring('<think>'.length).trim();
      }
      return ''; // No thinking content in this reply
    })
    .filter(thinking => thinking && thinking.trim());

  return thinkingParts.join('\n\n');
}
