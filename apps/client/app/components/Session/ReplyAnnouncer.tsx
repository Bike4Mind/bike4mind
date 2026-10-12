import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import type { IChatHistoryItem } from '@bike4mind/common';
import { visuallyHidden } from '@client/app/utils/a11yStyles';

// Long replies are cut so the announcement stays a cue; the full text is in the transcript.
const MAX_ANNOUNCED_CHARS = 600;

/** Plain-text announcement for a finished reply, or null when it has no text yet. */
export const replyAnnouncementText = (item: Pick<IChatHistoryItem, 'reply' | 'replies'>): string | null => {
  const raw = item.reply || item.replies?.find(Boolean) || '';
  const text = raw
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > MAX_ANNOUNCED_CHARS ? `${text.slice(0, MAX_ANNOUNCED_CHARS).trimEnd()}...` : text;
};

interface ReplyAnnouncerProps {
  sessionId: string;
  activeStreamingQuestId: string | null;
  chatHistory: IChatHistoryItem[];
}

/**
 * Polite live region that reads a reply once it finishes streaming. The streaming transcript itself
 * is deliberately not live: announcing every token would talk over the user.
 */
const ReplyAnnouncer = ({ sessionId, activeStreamingQuestId, chatHistory }: ReplyAnnouncerProps) => {
  const [message, setMessage] = useState('');
  // The quest whose reply is still owed an announcement. It outlives the stream because the
  // finished reply can land in the history a render or two after streaming data clears.
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    pendingRef.current = null;
    setMessage('');
  }, [sessionId]);

  useEffect(() => {
    if (activeStreamingQuestId) {
      if (pendingRef.current !== activeStreamingQuestId) setMessage('');
      pendingRef.current = activeStreamingQuestId;
      return;
    }
    const pendingId = pendingRef.current;
    if (!pendingId) return;
    const item = chatHistory.find(entry => entry.id === pendingId);
    const text = item ? replyAnnouncementText(item) : null;
    if (!text) return;
    pendingRef.current = null;
    setMessage(text);
  }, [activeStreamingQuestId, chatHistory]);

  return (
    <Box role="status" aria-live="polite" aria-atomic="true" data-testid="reply-announcer" sx={visuallyHidden}>
      {message}
    </Box>
  );
};

export default ReplyAnnouncer;
