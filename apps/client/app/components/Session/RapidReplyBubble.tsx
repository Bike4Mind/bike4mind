import { Box, Typography } from '@mui/joy';
import type { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';

interface RapidReplyBubbleProps {
  chatCompletion: ReturnType<typeof useSubscribeChatCompletion>['chatCompletion'];
}

/** The instant acknowledgement shown while the real answer is still streaming.
 *  Rendered above the streaming reply body so the transcript reads in the order
 *  the two responses were produced. */
const RapidReplyBubble = ({ chatCompletion }: RapidReplyBubbleProps) => {
  const rapidReply = chatCompletion.rapidReply;
  if (!rapidReply || rapidReply.status === 'replaced' || !chatCompletion.statusMessage) return null;

  return (
    <Box
      className="rapid-reply-container"
      data-testid="rapid-reply-container"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        mt: 2,
        mb: 1,
        p: 2,
        backgroundColor: 'chatbox.replyBg',
        borderRadius: '8px',
        position: 'relative',
      }}
    >
      <Typography
        level="body-md"
        sx={{
          color: 'text.primary',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
          '& p:last-child': { mb: '0 !important' },
        }}
      >
        {rapidReply.content}
      </Typography>
    </Box>
  );
};

export default RapidReplyBubble;
