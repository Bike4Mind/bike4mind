import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import type { IChatHistoryItem } from '@bike4mind/common';
import { visuallyHidden } from '@client/app/utils/a11yStyles';

// Long replies are cut so the announcement stays a cue; the full text is in the transcript.
const MAX_ANNOUNCED_CHARS = 600;

// Same field PromptReplies renders, so the strips below must stay in sync with what it hides
// (<think>) or lifts into a card (<artifact>). An unclosed tag runs to the end of the reply.
const THINK_BLOCK = /<think>[\s\S]*?(?:<\/think>|$)/g;
const ARTIFACT_BLOCK = /<artifact\b[\s\S]*?(?:<\/artifact>|$)/gi;

const flattenMarkdown = (markdown: string): string =>
  markdown
    .replace(THINK_BLOCK, ' ')
    .replace(ARTIFACT_BLOCK, ' artifact ')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, '$2')
    .replace(/(^|\W)(_{1,3})(?=\S)([^_\n]*?\S)\2(?!\w)/g, '$1$3')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, row => row.replace(/\|/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

type AnnounceableItem = Pick<IChatHistoryItem, 'reply' | 'replies'> &
  Partial<Pick<IChatHistoryItem, 'images' | 'videos'>>;

/**
 * Plain-text announcement for a finished reply. Image- and video-only replies get a short cue so
 * they are not silent; null means there is nothing to say (yet).
 */
export const replyAnnouncementText = (item: AnnounceableItem): string | null => {
  const text = flattenMarkdown(item.reply || item.replies?.find(Boolean) || '');
  if (text) return text.length > MAX_ANNOUNCED_CHARS ? `${text.slice(0, MAX_ANNOUNCED_CHARS).trimEnd()}...` : text;
  if (item.videos?.length) return 'Video ready';
  if (item.images?.length) return 'Image ready';
  return null;
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
